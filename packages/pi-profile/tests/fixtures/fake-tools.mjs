// Stand-ins for aws, rclone, age and age-keygen, run through sh wrappers on
// PATH: `node fake-tools.mjs <tool> ARGS...`. Each call is logged as a JSON line
// to $FAKE_LOG, and so is each object aws or rclone writes, as ["wrote", key].
//
// A fake bucket is a directory: s3://BUCKET/PREFIX and REMOTE:BUCKET/PREFIX
// are $FAKE_S3/BUCKET/PREFIX. $FAKE_S3_EXTRA may name a JSON file of extra
// {key: text} objects under the source prefix, for keys a file system cannot
// hold (such as `a/../b`). aws and rclone write every key they let through
// with a plain join, as a careless tool might, unless $FAKE_SAFE is set,
// when they skip keys that would land outside the destination (as the real
// tools do). $FAKE_NO_FILTER ignores the filter flags entirely.
//
// A download that cannot write one object (a name too long for the file
// system, say) goes on with the others and exits 1 at the end, as the real
// aws and rclone do. `aws s3 ls` and `rclone lsf` list what is there; a
// prefix with nothing under it gives aws exit 1 with no output, and rclone
// exit 3.
//
// age: `--encrypt -r R... -o OUT` writes `FAKEAGE\n<recipients>\n<plaintext>`;
// `--decrypt -i IDENTITY -o OUT` decrypts when the identity's public key is
// a recipient, and otherwise fails with a message that quotes the identity
// path, as real age's messages can.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

const [tool, ...args] = process.argv.slice(2);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify([tool, args])}\n`);

function fail(message, code = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function bucketPath(uri) {
	const root = process.env.FAKE_S3 ?? fail("FAKE_S3 is not set");
	if (uri.startsWith("s3://")) return join(root, uri.slice(5));
	const m = /^[A-Za-z0-9_-]+:(.*)$/.exec(uri);
	return m === null ? fail(`not a remote path: ${uri}`) : join(root, m[1]);
}

/** Every object under a source: files in the directory, plus $FAKE_S3_EXTRA. */
function objects(dir, extra = true) {
	const out = new Map();
	const walk = (d, prefix) => {
		if (!existsSync(d)) return;
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
			else if (e.isFile()) out.set(`${prefix}${e.name}`, readFileSync(join(d, e.name)));
		}
	};
	walk(dir, "");
	if (extra && process.env.FAKE_S3_EXTRA) for (const [k, v] of Object.entries(JSON.parse(readFileSync(process.env.FAKE_S3_EXTRA, "utf8")))) out.set(k, Buffer.from(v));
	return out;
}

let failures = 0;
function write(dest, key, data) {
	const out = join(dest, key);
	const rel = relative(resolve(dest), resolve(out));
	if (process.env.FAKE_SAFE && (rel.startsWith("..") || rel.startsWith(sep))) return;
	try {
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, data);
	} catch (error) {
		failures++;
		process.stderr.write(`download failed: ${key} to ${out} ${error.code}\n`);
		return;
	}
	if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(["wrote", key])}\n`);
}

/** Python fnmatch, as the aws CLI filters use it: `*` also matches `/`. */
function fnmatch(pattern, text) {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[") {
			const end = pattern.indexOf("]", i + 2);
			if (end < 0) re += "\\[";
			else {
				const body = pattern.slice(i + 1, end);
				re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
				i = end;
			}
		} else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "s").test(text);
}

/**
 * rclone glob: `*` stops at `/`, `**` does not, `[!..]` is a negated class
 * and `{{re}}` a regular expression; a leading `/` anchors at the root,
 * otherwise the pattern matches the end of the path.
 */
function rcloneMatch(pattern, path) {
	const anchored = pattern.startsWith("/");
	const body = anchored ? pattern.slice(1) : pattern;
	let re = "";
	for (let i = 0; i < body.length; i++) {
		if (body.startsWith("{{", i)) {
			const end = body.indexOf("}}", i + 2);
			re += `(?:${body.slice(i + 2, end)})`;
			i = end + 1;
		} else if (body[i] === "[") {
			const end = body.indexOf("]", i + 2);
			const cls = body.slice(i + 1, end);
			re += `[${cls.startsWith("!") ? `^${cls.slice(1)}` : cls}]`;
			i = end;
		} else if (body.startsWith("**", i)) {
			re += ".*";
			i++;
		} else if (body[i] === "*") re += "[^/]*";
		else if (body[i] === "?") re += "[^/]";
		else re += body[i].replace(/[.+^${}()|[\]\\/]/g, "\\$&");
	}
	return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`, "s").test(path);
}

function awsLs() {
	const uri = args[2];
	const base = bucketPath(uri);
	if (uri.endsWith("/")) {
		if (!existsSync(base)) process.exit(1);
		const lines = readdirSync(base, { withFileTypes: true }).map((e) => (e.isDirectory() ? `                           PRE ${e.name}/` : `2026-01-01 00:00:00         1 ${e.name}`));
		if (lines.length === 0) process.exit(1);
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}
	if (!existsSync(base)) process.exit(1);
	process.stdout.write(`2026-01-01 00:00:00         2 ${uri.slice(uri.lastIndexOf("/") + 1)}\n`);
}

function aws() {
	if (args[0] === "s3" && args[1] === "ls") return awsLs();
	if (args[0] !== "s3" || args[1] !== "cp" || !args.includes("--recursive")) fail(`fake aws: unsupported ${args.join(" ")}`, 252);
	const filters = [];
	const positional = [];
	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--exclude" || args[i] === "--include") filters.push([args[i], args[++i]]);
		else if (!args[i].startsWith("--")) positional.push(args[i]);
	}
	const [src, dest] = positional;
	if (!src.startsWith("s3://")) {
		// An upload: copy the local tree into the bucket.
		for (const [key, data] of objects(src, false)) {
			const out = join(bucketPath(dest), key);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, data);
		}
		return;
	}
	for (const [key, data] of objects(bucketPath(src))) {
		let keep = true;
		if (!process.env.FAKE_NO_FILTER) for (const [kind, pattern] of filters) if (fnmatch(pattern, key)) keep = kind === "--include";
		if (keep) write(dest, key, data);
	}
	if (failures > 0) process.exit(1);
}

function rcloneLsf() {
	const dd = args.indexOf("--");
	const dir = bucketPath(args[dd + 1]);
	if (!existsSync(dir)) fail("directory not found", 3);
	const include = args[args.indexOf("--include") + 1];
	const found = [...objects(dir, false).keys()].filter((k) => rcloneMatch(include, k));
	if (found.length > 0) process.stdout.write(`${found.join("\n")}\n`);
}

function rclone() {
	if (args[0] === "lsf") return rcloneLsf();
	if (args[0] !== "copy") fail(`fake rclone: unsupported ${args[0]}`);
	const dd = args.indexOf("--");
	const [src, dest] = args.slice(dd + 1);
	const rules = args.slice(1, dd).filter((a) => a.startsWith("--filter=")).map((a) => a.slice("--filter=".length));
	if (!/^[A-Za-z0-9_-]+:/.test(src)) {
		for (const [key, data] of objects(src, false)) {
			const out = join(bucketPath(dest), key);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, data);
		}
		return;
	}
	const dir = bucketPath(src);
	if (!existsSync(dir) && !process.env.FAKE_S3_EXTRA) fail("directory not found", 3);
	for (const [key, data] of objects(dir)) {
		let keep = true;
		if (!process.env.FAKE_NO_FILTER) {
			const rule = rules.find((r) => rcloneMatch(r.slice(2), key));
			keep = rule === undefined || rule.startsWith("+");
		}
		if (keep) write(dest, key, data);
	}
	if (failures > 0) process.exit(1);
}

function age() {
	const out = args[args.indexOf("-o") + 1];
	const input = readFileSync(0);
	if (args.includes("--encrypt")) {
		const recipients = args.flatMap((a, i) => (a === "-r" ? [args[i + 1]] : []));
		writeFileSync(out, Buffer.concat([Buffer.from(`FAKEAGE\n${recipients.join(" ")}\n`), input]));
		return;
	}
	const identity = args[args.indexOf("-i") + 1];
	const key = /# public key: (\S+)/.exec(readFileSync(identity, "utf8"))?.[1];
	const text = input.toString("latin1");
	const [magic, recipients] = text.split("\n", 2);
	if (magic !== "FAKEAGE") fail("age: error: failed to read header: parsing age header: unexpected intro");
	if (key === undefined || !recipients.split(" ").includes(key)) fail(`age: error: no identity matched any of the recipients (identity file ${JSON.stringify(identity)})`);
	writeFileSync(out, input.subarray(magic.length + recipients.length + 2));
}

function keygen() {
	const out = args[args.indexOf("-o") + 1];
	const pub = `age1${randomBytes(29).toString("hex").slice(0, 58)}`;
	writeFileSync(out, `# created: 2026-01-01T00:00:00Z\n# public key: ${pub}\nAGE-SECRET-KEY-1FAKE${randomBytes(16).toString("hex").toUpperCase()}\n`, { mode: 0o600 });
	process.stderr.write(`Public key: ${pub}\n`);
}

if (tool === "aws") aws();
else if (tool === "rclone") rclone();
else if (tool === "age") age();
else if (tool === "age-keygen") keygen();
else fail(`fake-tools: unknown tool ${tool}`);
