import { randomBytes, scryptSync } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSecretName } from "./auth.ts";
import { allowPathProblem, type AllowFinding, type SyncSetting } from "./manifest.ts";
import type { Layout } from "./paths.ts";
import { loadProfile } from "./profiles.ts";
import { REPLICA_KINDS, type ReplicaKind } from "./replica.ts";
import { printable } from "./repo.ts";
import { Refusal } from "./result.ts";
import { settingsSessionDir } from "./sessions.ts";
import { compilePattern, covers, mayMatchBelow, type Pattern } from "./syncpattern.ts";

/**
 * The sync manifest: the class of every path in a profile directory, and the
 * channels each class may ride. Deny by default: only `config` rides config
 * sync, and a path no rule names is `unknown` and stays on this host.
 * Nothing syncs yet; this module only decides what may.
 */

/** Mirrors `N.PathClass` in model/enums.json. */
export const PATH_CLASSES = ["config", "state", "secret", "sessions", "unknown"] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

/** Mirrors `Channel` in model/Domain.bend: the ways data leaves a profile directory. */
export type Channel = { readonly kind: "configSync" } | { readonly kind: "backup"; readonly replica: ReplicaKind } | { readonly kind: "authTransfer" };
export const CHANNELS: readonly Channel[] = [
	{ kind: "configSync" },
	...REPLICA_KINDS.map((replica): Channel => ({ kind: "backup", replica })),
	{ kind: "authTransfer" },
];

/** `mayCarry` in model/Domain.bend (laws L9, L10, L11). */
export function mayCarry(cls: PathClass, ch: Channel): boolean {
	switch (cls) {
		case "config":
			return ch.kind === "configSync";
		case "secret":
			return ch.kind === "authTransfer";
		case "sessions":
			return ch.kind === "backup";
		case "state":
		case "unknown":
			return false;
	}
}

/** The user's `sync` setting from profile.json, plus the profile's in-profile session directory. */
export interface SyncRules {
	readonly include: readonly string[];
	readonly exclude: readonly string[];
	/** Session directories inside the profile, relative and `/`-separated. */
	readonly sessionDirs: readonly string[];
	/** `sync.allowFindings`: credential-scan findings the user has checked. Each matches one line of one file by its hash. */
	readonly allowFindings?: readonly AllowFinding[];
}

/**
 * Credential file names, tested against a normalised name (`normalName`).
 * A match in any segment makes the path a secret; a directory such as
 * `.ssh/` makes its whole tree a secret.
 */
const SECRET_NAMES: readonly RegExp[] = [
	/^\.?auth.*\.json(\..*)?$/, // auth*.json, its backups, and editor copies such as .auth.json.swp
	/^\.env(rc)?(\..*)?$/,
	/\.(pem|key|p8|p12|pfx|jks|keystore|ppk|kdbx|gpg)$/,
	/^[._]?(netrc|pgpass|htpasswd|npmrc|pypirc|s3cfg)([._-].*)?$/, // with any suffix: netrc.conf, pgpass.conf
	/^\.?(yarnrc|yarnrc\.yml)$/,
	/^(tokens?|passwords?|api[-_]?keys?)(\..*)?$/, // token.txt, password.txt, api-key.md
	/^id_[a-z0-9_-]+(\.pub)?$/, // ssh keys: id_rsa, id_ed25519, id_ecdsa_sk
	/credential/, // credentials, .git-credentials, gcp-credentials.json
	/token.*\.json$/, // token.json, oauth-token.json
	/oauth.*\.json$/,
	/^hosts\.ya?ml$/, // gh CLI
	/^cookies?([._-].*)?$/,
	/kubeconfig/,
	/service[-_]?account.*\.json$/,
	/^\.?secrets?([._-].*)?$/,
	/^\.(ssh|aws|gnupg|docker|kube|azure|password-store)$/, // whole trees
];

/**
 * A name as a credential test sees it: NFKC, lower case, without control
 * or format characters, without leading and trailing spaces, and without a
 * trailing `~`, `.swp`, `.swo`, `#` or `.` (editor copies and look-alikes).
 */
export function normalName(name: string): string {
	let n = name.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, "").toLowerCase().trim();
	for (;;) {
		const m = n.replace(/(~|\.sw[po]|#|\s|\.)$/u, "").replace(/^(\.?#)/u, "");
		if (m === n || m === "") return n;
		n = m;
	}
}

export function isSecretSegment(name: string): boolean {
	const n = normalName(name);
	const bare = n.replace(/^\./, "");
	return isSecretName(name) || isSecretName(n) || SECRET_NAMES.some((r) => r.test(n) || r.test(bare));
}

/** A name that may look like another: any character outside printable ASCII, or leading or trailing space or dot. */
function suspectName(name: string): boolean {
	return /[^\x20-\x7e]/.test(name) || /^\s|\s$|\.$/.test(name);
}

/** The trees whose files are config only by file type. */
const TYPED_TREES = ["skills", "prompts"];
/** The text file types a skill or prompt may hold. Anything else there (binaries, archives, databases, unknown types) is unknown. */
export const CONFIG_FILE_TYPES = [
	"md",
	"markdown",
	"mdx",
	"txt",
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonc",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"py",
	"go",
	"rs",
	"rb",
	"lua",
	"sql",
	"bend",
	"tmpl",
	"html",
	"css",
	"svg",
	"xml",
	"csv",
] as const;
const CONFIG_FILE = new RegExp(`\\.(${CONFIG_FILE_TYPES.join("|")})$`, "i");
/** Whole names a skill or prompt may hold although their type is not in `CONFIG_FILE_TYPES`. Matched exactly. */
export const CONFIG_FILE_NAMES = ["README", "LICENSE", "Makefile", "Dockerfile", ".gitignore", ".gitkeep", "bend-version", "bun.lock", "package-lock.json", "pnpm-lock.yaml"] as const;
const CONFIG_NAMES: ReadonlySet<string> = new Set(CONFIG_FILE_NAMES);

function configFileName(name: string): boolean {
	return CONFIG_NAMES.has(name) || CONFIG_FILE.test(name);
}

/** A name with no type: no `.` after its first character. */
function extensionless(name: string): boolean {
	return name.length > 0 && !name.slice(1).includes(".");
}

/**
 * Whether the regular file at `abs` is a script: it starts with `#!`, has
 * no NUL byte, is valid UTF-8 and is at most 1 MiB. Opened without
 * following a link.
 */
function textScript(abs: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > MAX_SCAN_BYTES || st.size < 2) return false;
		const buf = Buffer.alloc(st.size);
		let got = 0;
		while (got < buf.length) {
			const n = readSync(fd, buf, got, buf.length - got, got);
			if (n === 0) break;
			got += n;
		}
		return scriptBytes(buf.subarray(0, got));
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Whether these bytes are a script: `#!` first, no NUL byte, valid UTF-8, at most 1 MiB. */
function scriptBytes(bytes: Buffer): boolean {
	if (bytes.length < 2 || bytes.length > MAX_SCAN_BYTES || bytes[0] !== 0x23 || bytes[1] !== 0x21 || bytes.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * The class of `rel` judged from its bytes, as config sync re-checks a
 * staged file: `classify`, and an extensionless file in skills/ or prompts/
 * is config when the bytes are a script.
 */
export function classifyContent(rel: string, rules: SyncRules, bytes: Buffer): Classed {
	const c = classify(rel, rules);
	return c.why === "filetype" && extensionless(rel.split("/").pop() ?? "") && scriptBytes(bytes) ? { cls: "config" } : c;
}

/** Names that are machine-local wherever they appear: logs, backups, temp files, locks, git and npm trees. */
const STATE_NAMES = [/\.log$/i, /\.bak/i, /\.backup/i, /\.tmp$/i, /^\.pi-profile\.lock/, /^\.git$/, /^node_modules$/, /^\.DS_Store$/];

const SESSIONS: readonly Pattern[] = ["sessions"].map(compilePattern);

/** The portable layer: Pi's own config and the extension configs known to hold settings, not state. */
export const CONFIG_PATTERNS = [
	"profile.json",
	"settings.json",
	"AGENTS.md",
	"skills",
	"prompts",
	"models.json",
	"acp.json",
	"fabric.json",
	"web-search.json",
	"context-aware.json",
	"command-guard.json",
	"adaptive-thinking.json",
	"pi-caair-dev-tools.json",
	"pi-multi-account/config.json",
] as const;
const CONFIG: readonly Pattern[] = CONFIG_PATTERNS.map(compilePattern);

/** Caches, installed tools, registries and extension runtime data. */
export const STATE_PATTERNS = [
	"cache",
	"npm",
	"bin",
	"install",
	"git-provenance",
	"session-registry",
	"web-search-cache",
	"context-cache",
	"callbacks",
	"intercom",
	"fabric",
	"pi-multi-account",
	"crashes.json",
	"models-store.json",
	"trust.json",
	"context-aware-worktrees.json",
	"profile-env.json",
	".billion-context-pi-update-check-*",
] as const;
const STATE: readonly Pattern[] = STATE_PATTERNS.map(compilePattern);

function under(segs: readonly string[], dir: string): boolean {
	const d = dir.split("/");
	return d.length <= segs.length && d.every((s, i) => s === segs[i]);
}

function anyCovers(patterns: readonly string[], segs: readonly string[]): boolean {
	return patterns.some((p) => covers(compilePattern(p), segs));
}

function stateByName(segs: readonly string[]): boolean {
	return segs.some((s) => STATE_NAMES.some((r) => r.test(s)));
}

/** Why a path that might have been config is `unknown`. */
export type UnknownReason = "link" | "hardlink" | "special" | "lookalike" | "filetype";
export const UNKNOWN_REASONS: Record<UnknownReason, string> = {
	link: "a link: never followed, never config",
	hardlink: "a hard link: another name shares its contents",
	special: "not a regular file or directory",
	lookalike: "a non-ASCII, invisible or padded character in its name",
	filetype: "not an allowlisted file type in skills/ or prompts/",
};

export interface Classed {
	readonly cls: PathClass;
	readonly why?: UnknownReason;
}

/**
 * The class of `rel`, a `/`-separated path relative to the profile
 * directory, and why it is unknown when a stricter rule demoted it.
 * Precedence: a secret name anywhere in the path; then sessions; then
 * machine-local names; then `exclude` (state); then the built-in config
 * rules, where a file under skills/ or prompts/ must have an allowlisted
 * type (`include` cannot override this); then the built-in state rules;
 * then `include`, which can only widen an unknown path to config. A path
 * that would be config but has a look-alike name (`suspectName`) is
 * unknown instead.
 */
export function classify(rel: string, rules: SyncRules, dir = false): Classed {
	const segs = rel.split("/");
	if (segs.some(isSecretSegment)) return { cls: "secret" };
	if (SESSIONS.some((p) => covers(p, segs)) || rules.sessionDirs.some((d) => under(segs, d))) return { cls: "sessions" };
	if (stateByName(segs) || anyCovers(rules.exclude, segs)) return { cls: "state" };
	const lookalike = segs.some(suspectName);
	const typed = TYPED_TREES.includes(segs[0] as string) && segs.length > 1 && !dir;
	if (CONFIG.some((p) => covers(p, segs))) {
		if (lookalike) return { cls: "unknown", why: "lookalike" };
		if (!typed || configFileName(segs[segs.length - 1] as string)) return { cls: "config" };
		return { cls: "unknown", why: "filetype" };
	}
	if (STATE.some((p) => covers(p, segs))) return { cls: "state" };
	if (anyCovers(rules.include, segs)) return lookalike ? { cls: "unknown", why: "lookalike" } : { cls: "config" };
	return { cls: "unknown" };
}

/** `classify(rel, rules, dir).cls`. */
export function classifyPath(rel: string, rules: SyncRules, dir = false): PathClass {
	return classify(rel, rules, dir).cls;
}

export interface SurveyEntry {
	/** Relative to the profile directory, `/`-separated. */
	readonly path: string;
	readonly cls: PathClass;
	/** A directory reported as one entry: everything below has its class. */
	readonly dir: boolean;
	/** A symbolic link: never followed, and `unknown` unless its name is a secret. */
	readonly link: boolean;
	/** Why the entry is unknown, when a stricter rule demoted it. */
	readonly why?: UnknownReason;
}

/** Whether a directory's contents could have another class than the directory itself. */
function descend(rel: string, cls: PathClass, rules: SyncRules): boolean {
	const segs = rel.split("/");
	if (cls === "config") return true;
	if (cls === "state") return !stateByName(segs) && !anyCovers(rules.exclude, segs) && CONFIG.some((p) => mayMatchBelow(p, segs));
	if (cls === "unknown") return CONFIG.some((p) => mayMatchBelow(p, segs)) || rules.include.some((p) => mayMatchBelow(compilePattern(p), segs));
	return false;
}

/**
 * The class of a file system entry. A link is `secret` when its name is,
 * and otherwise `unknown`: never config, because its target is not looked
 * at. A config file that is not a regular file with one name is unknown.
 * An extensionless file in skills/ or prompts/ is config only when `abs`
 * (its absolute path) is given and it is a script (`textScript`).
 */
function entryClass(path: string, rules: SyncRules, st: Pick<Stats, "isSymbolicLink" | "isDirectory" | "isFile" | "nlink">, script?: () => boolean): Classed {
	if (st.isSymbolicLink()) return classify(path, rules).cls === "secret" ? { cls: "secret" } : { cls: "unknown", why: "link" };
	let c = classify(path, rules, st.isDirectory());
	if (c.why === "filetype" && script !== undefined && st.isFile() && extensionless(path.split("/").pop() ?? "") && script()) c = { cls: "config" };
	if (c.cls !== "config" || st.isDirectory()) return c;
	if (!st.isFile()) return { cls: "unknown", why: "special" };
	if (st.nlink > 1) return { cls: "unknown", why: "hardlink" };
	return c;
}

/**
 * The class of the file system entry `rel` at `abs`, as a survey sees it:
 * `lstat` only, and the first bytes of an extensionless file in skills/ or
 * prompts/ to see whether it is a script.
 */
export function entryClassAt(abs: string, rel: string, rules: SyncRules): Classed {
	return entryClass(rel, rules, lstatSync(abs), () => textScript(abs));
}

function walk(root: string, rel: string, rules: SyncRules, out: SurveyEntry[]): void {
	for (const d of readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true })) {
		const path = rel === "" ? d.name : `${rel}/${d.name}`;
		const dir = d.isDirectory();
		const link = d.isSymbolicLink();
		const c = link || dir ? entryClass(path, rules, { isSymbolicLink: () => link, isDirectory: () => dir, isFile: () => false, nlink: 1 }) : entryClass(path, rules, lstatSync(join(root, path)), () => textScript(join(root, path)));
		if (dir && c.why === undefined && descend(path, c.cls, rules)) walk(root, path, rules, out);
		else out.push(c.why === undefined ? { path, cls: c.cls, dir, link } : { path, cls: c.cls, dir, link, why: c.why });
	}
}

/**
 * Class every path in a profile directory. A directory whose whole tree has
 * one class is one entry. Links are reported, never followed. Reads names
 * and file metadata, and the contents only of an extensionless file in
 * skills/ or prompts/, to see whether it is a script.
 */
export function surveyProfile(dir: string, rules: SyncRules): SurveyEntry[] {
	const out: SurveyEntry[] = [];
	walk(dir, "", rules, out);
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `p` relative to the profile directory, `/`-separated, when it lies strictly inside it. */
function insideProfile(dir: string, p: string): string | undefined {
	if (!isAbsolute(p)) return undefined;
	const bases = [dir];
	try {
		bases.push(realpathSync(dir));
	} catch {
		// The unresolved path is enough.
	}
	for (const base of bases) {
		const r = relative(base, p);
		if (r !== "" && !r.startsWith("..") && !isAbsolute(r)) return r.split(sep).join("/");
	}
	return undefined;
}

/**
 * The sync rules of a profile. `strict` refuses a profile.json with errors,
 * because its `sync` setting cannot be trusted; doctor reports those errors
 * itself and uses the built-in rules alone.
 */
export function profileSyncRules(l: Layout, name: string, strict: boolean): { dir: string; rules: SyncRules } {
	const info = loadProfile(l, name);
	if (strict && info.manifestErrors.length > 0) throw new Refusal(`${name}: profile.json: ${info.manifestErrors.join("; ")}`);
	return { dir: info.dir, rules: syncRulesOf(info.dir, info.manifest.sync, settingsSessionDir(l, name)) };
}

/** The sync rules of the profile at `dir` with `sync` (its profile.json setting) and `sessionDir` (its settings.json one). */
export function syncRulesOf(dir: string, sync: SyncSetting | undefined, sessionDir: string | undefined): SyncRules {
	const inside = sessionDir === undefined ? undefined : insideProfile(dir, sessionDir);
	return {
		include: sync?.include ?? [],
		exclude: sync?.exclude ?? [],
		sessionDirs: inside === undefined ? [] : [inside],
		allowFindings: sync?.allowFindings ?? [],
	};
}

/** How an entry is listed: directories end in `/`. */
export function shown(e: SurveyEntry): string {
	return e.dir ? `${e.path}/` : e.path;
}

export interface CredentialFinding {
	readonly path: string;
	/** Where: JSON key paths such as `providers.x.apiKey`, or `line N`. Never the value. */
	readonly at: readonly string[];
	/** Why the file could not be scanned, when it could not. */
	readonly unscanned?: string;
}

/** One credential-looking value the scan found: where it is, never what it is. */
export interface Finding {
	/** The line it is on, from 1. */
	readonly line: number;
	/** The credential key (in parsed JSON, the key path), or the name of a credential shape such as `sk` or `jwt`. */
	readonly key: string;
	/** Where, as listed: `line N`, or a JSON key path. */
	readonly at: string;
	/** A credential shape (`sk-…`, a JWT, a private key and the like): it can never be allowed. */
	readonly shape: boolean;
}

/** A config file config sync would skip, and why. Locations only, never a value. */
export interface SkippedFile {
	readonly path: string;
	readonly reason: string;
	readonly findings: readonly Finding[];
}

/** A `sync.allowFindings` entry that cannot take effect, and why. */
export interface IgnoredAllow {
	readonly entry: AllowFinding;
	readonly reason: string;
}

export const SHAPE_NEVER_ALLOWED = "the line holds a credential shape, which can never be allowed";

/** A `sync.allowFindings` entry that matches no finding: where it points, never its salt or digest. */
export interface StaleAllow {
	readonly path: string;
	readonly line: number;
	readonly key: string;
}

export interface SyncStatus {
	readonly profile: string;
	readonly dir: string;
	readonly counts: Record<PathClass, number>;
	readonly unknown: readonly string[];
	/** Why an unknown entry was demoted, by its shown path. */
	readonly reasons: Readonly<Record<string, string>>;
	readonly links: ReadonlyArray<{ readonly path: string; readonly class: PathClass }>;
	readonly credentials: readonly CredentialFinding[];
	/** Config files config sync would skip, with the reason. */
	readonly skipped: readonly SkippedFile[];
	readonly ignoredAllows: readonly IgnoredAllow[];
	readonly staleAllows: readonly StaleAllow[];
}

export function syncStatus(l: Layout, name: string): SyncStatus {
	const { dir, rules } = profileSyncRules(l, name, true);
	const entries = surveyProfile(dir, rules);
	const counts: Record<PathClass, number> = { config: 0, state: 0, secret: 0, sessions: 0, unknown: 0 };
	for (const e of entries) counts[e.cls]++;
	const unknown = entries.filter((e) => e.cls === "unknown");
	const report = configReport(dir, entries, rules);
	return {
		profile: name,
		dir,
		counts,
		unknown: unknown.map(shown),
		reasons: Object.fromEntries(unknown.flatMap((e) => (e.why === undefined ? [] : [[shown(e), UNKNOWN_REASONS[e.why]]]))),
		links: entries.filter((e) => e.link).map((e) => ({ path: e.path, class: e.cls })),
		credentials: report.credentials,
		skipped: report.skipped,
		ignoredAllows: report.ignored,
		staleAllows: report.stale,
	};
}

/**
 * Credential words that make a key a credential key wherever they end it,
 * after any prefix: `apiKey`, `GH_TOKEN`, `client_secret`, `db-password`,
 * `PRIVATE_KEY`. Compared with the key's last words joined, so camel, snake,
 * kebab and upper case all match.
 */
const STRONG_WORDS = new Set([
	"password",
	"passwords",
	"passwd",
	"passphrase",
	"secret",
	"secrets",
	"token",
	"tokens",
	"apikey",
	"apikeys",
	"accesskey",
	"privatekey",
	"secretkey",
	"credential",
	"credentials",
	"authorization",
	"bearer",
	"cookie",
	"cookies",
]);
/** The longest `STRONG_WORDS` entry: `keyClass` joins no more of a key's last words than this, so its work is linear in the key. */
const STRONG_MAX = Math.max(...[...STRONG_WORDS].map((x) => x.length));
/** Short or common words that name a credential only as the whole key: `pass`, `PWD`, `auth`, `sessionId`, `session_id`. */
const WHOLE_WORDS = new Set(["pass", "pwd", "auth", "sessionid"]);
/**
 * Short words that name a credential as the last word of a longer key:
 * `DB_PASS`, `MYSQL_PWD`, `redis_auth`. They are common enough elsewhere
 * (`second_pass`, `use_auth`) that the value must also look like a secret
 * (`secretLike`), in settings files too.
 */
const LOOSE_WORDS = new Set(["pass", "pwd", "auth"]);
/**
 * Words that name a credential in a settings file only (JSON, YAML, TOML,
 * shell and the like), after any prefix: `key`, `openai.key`, `licenseKey`,
 * `access`, `refresh`. In code and prose they name map keys and verbs.
 */
const SETTINGS_WORDS = new Set(["key", "keys", "access", "refresh"]);
/** Credential words that may also name a section of settings, such as `auth: { mode: "shared" }`: a credential only when they hold a value directly. */
const SECTION_WORDS = new Set(["auth"]);
/** Words that make a key a count or a limit, not a credential: `maxTokens`, `reserveTokens`, `keepRecentTokens`. */
const QUANTITY_WORDS = new Set(["max", "min", "count", "limit", "reserve", "budget", "num", "total", "length", "size", "ttl", "timeout", "threshold", "keep", "recent", "input", "output", "usage", "used", "estimated", "per", "rate", "context", "cache", "prompt", "completion", "thinking", "reasoning"]);
/** Words before `token` that make it a word or a position, not a credential: `separatorToken`, `nextPageToken`. */
const LEXICAL_WORDS = new Set(["separator", "replacement", "delimiter", "cancel", "cancellation", "continuation", "next", "page", "cursor", "stop", "special", "design"]);
/** Last words that make a key name a password, whose quoted value may hold spaces. */
const PASSWORD_WORDS = new Set(["password", "passwords", "passwd", "passphrase", "pass", "pwd"]);

function words(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 0);
}

/** The last run of letters and digits in `key`, as written: `PGPASSWORD` in `export PGPASSWORD`. */
function lastPart(key: string): string {
	const parts = key.split(/[^A-Za-z0-9]+/);
	for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i] as string;
	return "";
}

/** An all-capitals word that ends in `PASSWORD`: `PGPASSWORD`, `DBPASSWORD`. */
function capsPassword(key: string): boolean {
	return CAPS_PASSWORD.test(lastPart(key));
}

/**
 * How a key names a credential.
 * - `strong`: any literal counts, subject to the rules of the file kind.
 * - `loose`: a `LOOSE_WORDS` last word after a prefix (`DB_PASS`): the value
 *   must look like a secret, in settings files too.
 * - `named`: outside settings files, a key that ends in `Key` or `_key` after
 *   a prefix (`openaiKey`): the value must look like a generated key (`keyLike`).
 */
type KeyClass = "strong" | "loose" | "named";

function keyClass(key: string, settings: boolean): KeyClass | undefined {
	const w = words(key);
	if (w.length === 0 || w.some((x) => QUANTITY_WORDS.has(x))) return undefined;
	if (WHOLE_WORDS.has(w.join(""))) return "strong";
	const last = w[w.length - 1] as string;
	if (settings && SETTINGS_WORDS.has(last)) return "strong";
	let tail = "";
	for (let i = w.length - 1; i >= 0; i--) {
		tail = (w[i] as string) + tail;
		if (tail.length > STRONG_MAX) break;
		if (STRONG_WORDS.has(tail)) return /^tokens?$/.test(last) && w.length > 1 && LEXICAL_WORDS.has(w[w.length - 2] as string) ? undefined : "strong";
	}
	if (capsPassword(key)) return "strong";
	if (w.length > 1 && LOOSE_WORDS.has(last)) return "loose";
	if (w.length > 1 && (last === "key" || last === "keys")) return "named";
	return undefined;
}

/**
 * Whether `key` names a credential. `settings`: the key is in a settings
 * file (JSON, YAML, TOML, shell and the like), where `SETTINGS_WORDS` count
 * too. No word may make it a quantity (`maxTokens`), and `token` after a
 * `LEXICAL_WORDS` word does not count. A `loose` or `named` key (`keyClass`)
 * also needs a value that looks like a secret.
 */
export function credentialKey(key: string, settings = true): boolean {
	return keyClass(key, settings) !== undefined;
}

/** Whether `key` names a password: its quoted value may hold spaces. */
function passwordKey(key: string): boolean {
	const w = words(key);
	return PASSWORD_WORDS.has(w[w.length - 1] ?? "") || capsPassword(key);
}

/** Whether a credential key also owns an object or list below it (`SECTION_WORDS` do not). */
function ownsBelow(key: string): boolean {
	const w = words(key);
	return !SECTION_WORDS.has(w[w.length - 1] as string);
}

/**
 * A reference to a credential held elsewhere, not the credential. Exactly
 * these forms count: `${VAR}`, `$VAR`, `env:VAR` (VAR is a shell name:
 * a letter or `_`, then letters, digits or `_`), and `!command`. A bare
 * name such as `OPENAI_API_KEY` is not a reference: it is a literal.
 * Pi and pi-web-access do not resolve `env:VAR`; `envColonPaths` finds it
 * in their files for doctor.
 */
export function credentialReference(v: string): boolean {
	return REFERENCE.test(v) || COMMAND.test(v);
}

/**
 * A value that would be a credential under a credential key: a non-empty
 * string that is not a reference, or a number. An environment variable
 * after an auth scheme (`Bearer ${TOKEN}`, `Basic $AUTH`) is a reference
 * too: Pi expands it in a `models.json` header. A `!command` or `env:VAR`
 * there is not, since neither reader resolves it after a scheme.
 */
function literal(v: unknown): boolean {
	if (typeof v === "string") {
		const t = v.trim();
		return t.length > 0 && !credentialReference(t) && !(t !== unscheme(t) && SCHEMED_REFERENCE.test(unscheme(t)));
	}
	return typeof v === "number" && Number.isFinite(v);
}

/** A credential shape: a value that is a credential under any key, or in any text. */
export interface CredentialShape {
	readonly name: string;
	/** A hard shape can never be allowed by `sync.allowFindings`. */
	readonly hard: boolean;
	readonly re: RegExp;
}

/**
 * Value shapes that are credentials under any key, or in any text. Each
 * pattern starts after a boundary (a lookbehind, `\b` or a literal), so a
 * long run of letters is tried from one place, not from each of its
 * characters: every pattern runs in time linear in the line. Every shape
 * is hard but `Bearer <token>`, which examples use with made-up tokens, and
 * URL userinfo whose password only stands in for one (`url-userinfo-example`).
 */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
	{ name: "sk", hard: true, re: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/ }, // OpenAI, Anthropic and similar keys
	{ name: "github", hard: true, re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/ }, // GitHub tokens
	{ name: "github", hard: true, re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/ },
	{ name: "slack", hard: true, re: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "aws", hard: true, re: /(?<![A-Za-z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/ }, // AWS access key id
	{ name: "jwt", hard: true, re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
	// URL userinfo user:password@, the password captured. The lookbehind starts the scheme only at its first character: without it, a long run of letters is quadratic.
	{ name: "url-userinfo", hard: true, re: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/ },
	// The same, with a password that only stands in for one (`USERINFO_EXAMPLE`): soft. `shapesOf` tells the two apart.
	{ name: "url-userinfo-example", hard: false, re: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/ },
	{ name: "private-key", hard: true, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "bearer", hard: false, re: /\bBearer\s+(?=[A-Za-z0-9._~+/-]*[0-9_-])[A-Za-z0-9._~+/-]{6,}/ }, // a bearer token, not the word "Bearer token"
];

/** Every URL userinfo in a line, the password captured: the `url-userinfo` pattern, global. */
const USERINFO = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]+)@/g;
/**
 * A URL userinfo password that only stands in for one, in any case: `pass`,
 * `password`, `passwd`, `pw`, `secret`, `changeme`, a run of `x` or `*`,
 * `<…>`, `${…}` or `{…}`. A closed list: any other password, `$VAR` included, is a hard shape.
 */
const USERINFO_EXAMPLE = /^(?:pass|password|passwd|pw|secret|changeme|x+|\*+|<[^<>]*>|\$\{[^{}]*\}|\{[^{}]*\}|\{\{[^{}]*\}\})$/i;
/** `Basic <base64>`, up to 1024 characters: the token is checked by `basicShape`. */
const BASIC = /\bBasic[ \t]+([A-Za-z0-9+/]{8,1024}={0,2})(?![A-Za-z0-9+/=])/g;
const REFERENCE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|env:[A-Za-z_][A-Za-z0-9_]*)$/;
const COMMAND = /^!\S/;
/** The environment variable forms Pi expands inside a header value. */
const SCHEMED_REFERENCE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)$/;
const CAPS_PASSWORD = /^[A-Z0-9]*PASSWORD$/;
/** Words joined by `-` or `_`, with at most a short number at the end: a name, not a secret. */
const JOINED_NAME = /^[A-Za-z]+([-_][A-Za-z]+)+([-_]?[0-9]{1,3})?$/;
/** A run of 12 or more letters and digits: the body of a generated key. */
const KEY_RUN = /[A-Za-z0-9]{12,}/g;
const SCHEME = /^(?:basic|bearer|token|digest)[ \t]+(\S+)$/i;
const SCHEME_WORD = /^(basic|bearer|token|digest)$/i;
const DOTTED = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const LINE_REFERENCE = /^\$[0-9@*#?]$|^\$\(|^\$\{\{|^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-?]\}$/;
const PASSPHRASE_WORDS = /pass|phrase|word/i;

/**
 * `Basic <base64 of user:password>`: a token a multiple of 4 long, with a
 * digit, `+`, `/` or `=`, or mixed case after its first letter (so not a
 * word such as `Authentication`), that decodes to bytes with a `:`.
 */
function basicShape(text: string): boolean {
	if (!text.includes("Basic")) return false;
	for (const m of text.matchAll(BASIC)) {
		const t = m[1] as string;
		if (t.length % 4 === 0 && (/[0-9+/=]/.test(t) || (/[A-Z]/.test(t.slice(1)) && /[a-z]/.test(t))) && Buffer.from(t, "base64").includes(0x3a)) return true;
	}
	return false;
}

interface Shape {
	readonly name: string;
	readonly hard: boolean;
}
const URL_USERINFO: Shape = { name: "url-userinfo", hard: true };
const URL_EXAMPLE: Shape = { name: "url-userinfo-example", hard: false };

/**
 * Every credential shape in `text`, each name once. URL userinfo is
 * `url-userinfo-example` (soft) when its password is a `USERINFO_EXAMPLE`,
 * else `url-userinfo` (hard); a line may hold both.
 */
function shapesOf(text: string): Shape[] {
	const out: Shape[] = [];
	const add = (s: Shape): void => {
		if (!out.some((o) => o.name === s.name)) out.push(s);
	};
	for (const s of CREDENTIAL_SHAPES) if (!s.name.startsWith("url-userinfo") && s.re.test(text)) add(s);
	if (text.includes("://"))
		for (const m of text.matchAll(USERINFO)) {
			add(USERINFO_EXAMPLE.test(m[1] as string) ? URL_EXAMPLE : URL_USERINFO);
			if (out.includes(URL_USERINFO) && out.includes(URL_EXAMPLE)) break;
		}
	if (basicShape(text)) add({ name: "basic", hard: true });
	return out;
}

/** Whether `text` holds a credential-shaped value. */
export function credentialShape(text: string): boolean {
	return shapesOf(text).length > 0;
}

/** A UUID: 8-4-4-4-12 hex digits. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A value made of one character repeated, ignoring `-`, `_`, `.`, `:` and
 * spaces, at least 3 times: `xxxx`, `0000`, `****`, a nil UUID. A UUID
 * counts without its version and variant digits, so
 * `00000000-0000-4000-8000-000000000000` is a nil UUID too. A placeholder.
 */
function repeatedChar(v: string): boolean {
	const u = v.trim();
	const t = (UUID.test(u) ? u.slice(0, 14) + u.slice(15, 19) + u.slice(20) : u).replace(/[-_.:\s]/g, "");
	if (t.length < 3) return false;
	for (let i = 1; i < t.length; i++) if (t[i] !== t[0]) return false;
	return true;
}

interface PathHit {
	readonly path: readonly string[];
	/** `path` as listed: a map key directly below a credential key (through any lists) is `*`, since it may be the secret. */
	readonly shown: readonly string[];
	readonly value: unknown;
	/** It holds a hard credential shape. */
	readonly shape: boolean;
	/** The names of the credential shapes in the value. */
	readonly shapes: readonly string[];
}

/** The key paths `credentialKeys` names, and whether each holds a hard credential shape. */
function credentialPaths(value: unknown): PathHit[] {
	const out: PathHit[] = [];
	/**
	 * `owner`: the nearest strong credential key above `v`, if any. `loose`: `v` sits directly under a `loose` key (`db_pass`).
	 * `under`: `v` is the value of a credential key that owns what is below it (not a section key such as `auth`), directly or through lists, so its map keys are shown as `*`.
	 */
	const visit = (v: unknown, path: readonly string[], shown: readonly string[], owner: string | undefined, loose: boolean, under: boolean): void => {
		if (Array.isArray(v)) v.forEach((x, i) => visit(x, [...path, String(i)], [...shown, String(i)], owner, false, under));
		else if (typeof v === "object" && v !== null)
			for (const [k, x] of Object.entries(v)) {
				const c = keyClass(k, true);
				const own = c === "strong" && (ownsBelow(k) || typeof x !== "object" || x === null);
				visit(x, [...path, k], [...shown, under ? "*" : k], owner ?? (own ? k : undefined), c === "loose", c !== undefined && ownsBelow(k));
			}
		else {
			const shapes = typeof v === "string" ? shapesOf(v) : [];
			const hit = (shape: boolean): void => {
				out.push({ path, shown, value: v, shape, shapes: shapes.map((s) => s.name) });
			};
			if (shapes.length > 0) hit(shapes.some((s) => s.hard));
			else if (owner !== undefined && literal(v) && !repeatedChar(String(v)) && !(owner !== path[path.length - 1] && describes(path[path.length - 1] ?? "", v)) && !(typeof v !== "string" && WHOLE_WORDS.has(words(owner).join("")))) hit(false);
			else if (loose && owner === undefined && typeof v === "string" && secretLike(v.trim()) && !credentialReference(v.trim()) && !repeatedChar(v)) hit(false);
		}
	};
	visit(value, [], [], undefined, false, false);
	return out;
}

/**
 * Dotted paths of credential-looking values in parsed JSON: a literal under
 * a credential key (also inside an object or array below one, except below
 * a section key such as `auth`), a secret-like string directly under a
 * loose key such as `db_pass`, or a credential-shaped string under any key.
 * A JSON Schema type name under `type` is not a value, and nor is a value
 * made of one repeated character. Never returns the values.
 */
export function credentialKeys(value: unknown): string[] {
	return credentialPaths(value).map((h) => (h.shown.length === 0 ? "(value)" : h.shown.join(".")));
}

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
/** Keys below a credential key that describe it rather than hold it: `token.description`, `CapToken.term`. */
const DESCRIPTIVE_KEYS = new Set(["description", "desc", "title", "label", "term", "tag", "name", "kind", "summary", "comment", "help"]);

/** Whether `v` under the key `k`, below a credential key, describes that key: a description, or a JSON Schema type name. */
function describes(k: string, v: unknown): boolean {
	return DESCRIPTIVE_KEYS.has(k) || (k === "type" && SCHEMA_TYPES.has(String(v)));
}

/**
 * The line of each value in JSON text that `JSON.parse` accepted, by its key
 * path joined with NUL, and the line of each key that repeats a key of its
 * object (`dups`). One pass over the text, without backtracking.
 */
function jsonValueLines(text: string): { lines: Map<string, number>; dups: number[] } {
	const out = new Map<string, number>();
	const dups: number[] = [];
	let i = 0;
	let line = 1;
	const space = (): void => {
		for (; i < text.length; i++) {
			const c = text[i];
			if (c === "\n") line++;
			else if (c !== " " && c !== "\t" && c !== "\r") return;
		}
	};
	const str = (): string => {
		const start = i++;
		while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		i++;
		return JSON.parse(text.slice(start, i)) as string;
	};
	const value = (path: readonly string[]): void => {
		space();
		const c = text[i];
		out.set(path.join("\0"), line);
		if (c === "{" || c === "[") {
			const close = c === "{" ? "}" : "]";
			i++;
			space();
			if (text[i] === close) {
				i++;
				return;
			}
			const seen = c === "{" ? new Set<string>() : undefined;
			for (let n = 0; ; n++) {
				space();
				let k = String(n);
				if (seen !== undefined) {
					k = str();
					if (seen.has(k)) dups.push(line);
					seen.add(k);
					space();
					i++; // the colon
				}
				value([...path, k]);
				space();
				if (text[i++] === close) return;
			}
		}
		if (c === '"') str();
		else while (i < text.length && !/[\s,\]}]/.test(text[i] as string)) i++;
	};
	value([]);
	return { lines: out, dups };
}

const SHAPE_NAMES: ReadonlySet<string> = new Set([...CREDENTIAL_SHAPES.map((s) => s.name), "basic"]);

/**
 * `sync.allowFindings[N].key` in the root profile.json holding what
 * `--allow-line` writes there: a credential key name (its last dotted part
 * that is not `*` or a list index is one, as in `providers.x.apiKey`,
 * `tokens.*` or `apiKeys.0`) or a shape name. It names a key, so it
 * is not a finding, and an allow entry does not flag its own file. Any other
 * value there, such as a pasted password, is still flagged.
 */
function allowKeyField(rel: string, h: PathHit): boolean {
	const p = h.path;
	if (rel !== "profile.json" || p.length !== 4 || p[0] !== "sync" || p[1] !== "allowFindings" || !/^[0-9]+$/.test(p[2] as string) || p[3] !== "key") return false;
	if (typeof h.value !== "string") return false;
	if (SHAPE_NAMES.has(h.value)) return true;
	const named = h.value.split(".").filter((x) => x !== "*" && !/^[0-9]+$/.test(x));
	return credentialKey(named[named.length - 1] ?? "", true);
}

/** The key of a finding for a key that repeats a key of its JSON object. */
export const DUPLICATE_KEY = "duplicate-key";

/**
 * Findings in JSON that parses: by key path (a map key below a credential key
 * shown as `*`), at the line of the value, plus each credential shape in the
 * raw text (in a key name too) that no key path on its line already reports.
 * A key that repeats a key of its object is a hard finding, `duplicate-key`:
 * `JSON.parse` keeps only the last value, but the raw text still holds the
 * others, so the file is refused rather than judged by the last.
 */
function jsonFindings(text: string, rel: string): Finding[] {
	const hits = credentialPaths(JSON.parse(text)).filter((h) => h.shape || !allowKeyField(rel, h));
	const { lines, dups } = jsonValueLines(text);
	const out: Finding[] = [];
	/** The shape names each line's key-path findings already cover. */
	const covered = new Map<number, Set<string>>();
	for (const h of hits) {
		const at = h.shown.length === 0 ? "(value)" : h.shown.join(".");
		const line = lines.get(h.path.join("\0")) ?? 1;
		out.push({ line, key: at, at, shape: h.shape });
		const c = covered.get(line) ?? new Set<string>();
		for (const s of h.shapes) c.add(s);
		covered.set(line, c);
	}
	for (const line of new Set(dups)) out.push({ line, key: DUPLICATE_KEY, at: `line ${String(line)} (duplicate key)`, shape: true });
	text.split("\n").forEach((l, i) => {
		for (const s of shapesOf(l)) if (!(covered.get(i + 1)?.has(s.name) ?? false)) out.push({ line: i + 1, key: s.name, at: `line ${String(i + 1)}`, shape: s.hard });
	});
	return out.sort((a, b) => a.line - b.line);
}

/**
 * A key and its separator anywhere in a line: `key = `, `key: `, `key := `,
 * `"key": `, `export KEY=`, `--key=`. The key may be quoted. A dotted name
 * (`config.apiKey = `) is matched by its last part; a kebab or snake name
 * (`api-key`, `api_key`) whole. `==`, `=>`, `=~`, `::` and `://` are
 * not separators.
 */
const PAIR = /(?<![A-Za-z0-9_$-])(?:--)?(["'`]?)([A-Za-z_][A-Za-z0-9_-]*)\1[ \t]*(:=|=(?![=>~])|:(?![:/]))[ \t]*/g;
/** Code files: a bare value there is an identifier, call or expression, never a credential. */
const CODE_TEXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rb|lua|ps1)$/i;
/** Settings files, where `SETTINGS_WORDS` name credentials and any value after `key:` counts. */
const SETTINGS_TEXT = /\.(json|jsonc|jsonl|ya?ml|toml|sh|bash|zsh|fish|env|ini|cfg|conf|properties)$/i;
/** Bare values that are not credentials: empty, structure, YAML block or anchor markers, constants and type names. */
const NOT_A_VALUE = /^([[{(<|>&*!].*|null|nil|none|undefined|~|true|false|yes|no|on|off|string|str|number|int|integer|float|bool|boolean|bytes|any|unknown|object|optional)?$/i;
/** A value that only stands in for one: `xxx`, `***`, `<token>`, `{{ x }}`, `your-api-key`, `changeme`, `…`. */
const PLACEHOLDER = /^(x{3,}|\*{3,}|<[^>]*>|\{\{.*\}\}|\[[^\]]*\]|your[-_ ].*|changeme|change[-_ ]me|replace[-_ ]?me|redacted|placeholder|example|sample|dummy|todo|tbd)$|\.\.\.|…/i;
/** After a separator, a value that starts on the next line: a YAML block marker (`|`, `>-`, `|+2`) or an opening `"""` or `'''`, then at most a comment. */
const BLOCK = /(?:[|>][-+]?[1-9]?[-+]?|"""|''')[ \t]*(?:#|$)/y;
/** After a separator, a triple-quoted value closed on the same line. */
const TRIPLE = /("""|''')(.{0,256}?)\1/y;
/** A bare value: a word, or `${…}`, up to 256 characters. Sticky, so it never copies the rest of the line. */
const BARE = /(?:\$\{[^}\s]{0,64}\}|[^\s,;'"`()[\]{}]){0,256}/y;
const BARE_CHAR = /[^\s,;'"`()[\]{}]/;
/** After a bare value, what may follow it in prose: nothing but a comment. Never `.*$`: that rescans the rest of the line for each key on it. */
const TAIL = /[\s,;]*(?:#|\/\/|$)/y;
/** Blanks before a value after a scheme word such as `Bearer`. */
const BLANKS = /[ \t]+(?=\S)/y;
/** How much of a value is read: enough to judge it, and a bound on the work for each key in a long line. */
const VALUE_CAP = 256;

type TextKind = "code" | "settings" | "text";

/** A reference in a line of text: the forms of `credentialReference`, `$1`, a `$(command)`, `${{ … }}`, or `${VAR:-}` with an empty default. */
function lineReference(v: string): boolean {
	return credentialReference(v) || LINE_REFERENCE.test(v);
}

/** A placeholder value: a `PLACEHOLDER` form, or one character repeated (`repeatedChar`). */
function placeholder(v: string): boolean {
	return PLACEHOLDER.test(v) || repeatedChar(v);
}

/**
 * The value after a separator at `i`: a quoted string (to its closing quote,
 * or the end of the line), or a bare word. At most `VALUE_CAP` characters are
 * read; `capped` says the value went on. `end` is the index after it.
 */
function valueAt(line: string, i: number): { quoted: boolean; text: string; end: number; capped: boolean } {
	const q = line[i];
	if (q === '"' || q === "'" || q === "`") {
		const stop = Math.min(line.length, i + 1 + VALUE_CAP);
		let j = i + 1;
		while (j < stop && line[j] !== q) j += line[j] === "\\" ? 2 : 1;
		if (j < line.length && line[j] === q) return { quoted: true, text: line.slice(i + 1, j), end: j + 1, capped: false };
		const end = Math.min(j, line.length);
		return { quoted: true, text: line.slice(i + 1, end), end, capped: end < line.length };
	}
	BARE.lastIndex = i;
	const m = BARE.exec(line) as RegExpExecArray;
	const end = i + m[0].length;
	return { quoted: false, text: m[0], end, capped: end < line.length && BARE_CHAR.test(line[end] as string) };
}

/** A quoted `Basic …`, `Bearer …`, `Token …` or `Digest …` value, without its scheme. */
function unscheme(text: string): string {
	const m = SCHEME.exec(text);
	return m === null ? text : (m[1] as string);
}

/**
 * A value that could be a secret in code or prose: no space, at least 6
 * characters, a digit or at least 10 characters, and not a name made of
 * words joined by `-` or `_` with at most a short number at the end
 * (`hunter2`, `abcd1234efgh`; not `github`, `session-main-1`).
 */
function secretLike(v: string): boolean {
	return !/\s/.test(v) && v.length >= 6 && (/[0-9]/.test(v) || v.length >= 10) && !JOINED_NAME.test(v);
}

/**
 * A value that looks like a generated key: `secretLike`, with a run of 12 or
 * more letters and digits that holds both (`abcd1234efgh`; not `user-123`
 * or `session-main-12345`).
 */
function keyLike(v: string): boolean {
	return secretLike(v) && [...v.matchAll(KEY_RUN)].some((m) => /[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0]));
}

/** A password with spaces, such as `correct horse battery`: 8 or more characters, and no word about passwords (`Enter your password`). */
function passphrase(v: string): boolean {
	return v.length >= 8 && /\s/.test(v) && !PASSPHRASE_WORDS.test(v);
}

/**
 * Whether `text`, the value of a key of class `c`, could be a credential,
 * before anything around it is checked: not empty, a placeholder or a
 * reference; then any value of a strong key in a settings file, a
 * generated-looking value of a `named` key, and elsewhere a `secretLike`
 * value, or a passphrase under a password key.
 */
function valueLooks(text: string, kind: TextKind, c: KeyClass, key: string): boolean {
	if (text === "" || placeholder(text) || lineReference(text)) return false;
	if (c === "named") return keyLike(text);
	if (c === "strong" && kind === "settings") return true;
	return secretLike(text) || (passwordKey(key) && passphrase(text));
}

/**
 * Whether a value found by `PAIR` is a credential literal. A quoted value
 * counts when `valueLooks` says so, unless it is (in a template string)
 * built from `${…}`. A quoted or bare `Basic`, `Bearer`, `Token` or `Digest`
 * scheme is skipped. A bare value never counts in a code file, where it is
 * an identifier, call or expression. Elsewhere a bare value counts unless it
 * is a constant, a dotted name or is followed by `(`, `[` or `.`, so an
 * environment read such as `process.env.X`, `os.environ["X"]` or
 * `os.getenv("X")` is never a value; and after `:` outside a settings file
 * only when nothing but a comment follows it, so prose such as
 * `Token: see below` is not a value.
 */
function keyedLiteral(line: string, i: number, sep: string, kind: TextKind, c: KeyClass, key: string): boolean {
	const q = line[i];
	const quote = q === '"' || q === "'" || q === "`";
	if (kind === "code" && !quote) return false;
	TRIPLE.lastIndex = i;
	const triple = quote ? TRIPLE.exec(line) : null;
	if (triple !== null) return valueLooks(unscheme((triple[2] as string).trim()), kind, c, key);
	let v = valueAt(line, i);
	if (!v.quoted && SCHEME_WORD.test(v.text)) {
		BLANKS.lastIndex = v.end;
		if (BLANKS.test(line)) v = valueAt(line, BLANKS.lastIndex);
	}
	const text = v.quoted ? unscheme(v.text.trim()) : v.text.trim();
	if (!valueLooks(text, kind, c, key)) return false;
	if (v.quoted) return !(q === "`" && text.includes("${"));
	if (NOT_A_VALUE.test(text) || DOTTED.test(text)) return false;
	if (v.capped) return true;
	if (/[([.]/.test(line[v.end] ?? "")) return false;
	if (sep !== ":" || kind === "settings") return true;
	TAIL.lastIndex = v.end;
	return TAIL.test(line);
}

/** The value on a line after a block marker: the line trimmed, without a closing `"""` or `'''`, at most `VALUE_CAP` characters. */
function blockValue(line: string): string {
	return line.slice(0, 4 * VALUE_CAP).trim().replace(/("""|''')$/, "").trim().slice(0, VALUE_CAP);
}

/**
 * Every credential key holding a literal in line `i` of `lines`, and the
 * line of each value: the next non-empty line (`after`) when the value is a
 * YAML block or an opening `"""`. Never returns a value.
 */
function keyedHits(lines: readonly string[], i: number, kind: TextKind, after: (i: number) => number): Array<{ line: number; key: string }> {
	const out: Array<{ line: number; key: string }> = [];
	const line = lines[i] as string;
	let classes: Map<string, KeyClass | undefined> | undefined;
	for (const m of line.matchAll(PAIR)) {
		const key = m[2] ?? "";
		classes ??= new Map();
		if (!classes.has(key)) classes.set(key, keyClass(key, kind === "settings"));
		const c = classes.get(key);
		if (c === undefined) continue;
		const at = (m.index ?? 0) + m[0].length;
		BLOCK.lastIndex = at;
		if (BLOCK.test(line)) {
			const j = after(i);
			if (j >= 0 && valueLooks(blockValue(lines[j] as string), kind, c, key)) out.push({ line: j + 1, key });
			continue;
		}
		if (keyedLiteral(line, at, m[3] ?? "", kind, c, key)) out.push({ line: i + 1, key });
	}
	return out;
}

/**
 * Every regular expression the line scan runs, other than `CREDENTIAL_SHAPES`,
 * by name. Exported so a test can run each over long hostile lines: each must
 * take time linear in its input.
 */
export const LINE_PATTERNS: Readonly<Record<string, RegExp>> = {
	PAIR,
	BASIC,
	BLOCK,
	TRIPLE,
	BARE,
	BARE_CHAR,
	TAIL,
	BLANKS,
	NOT_A_VALUE,
	PLACEHOLDER,
	REFERENCE,
	COMMAND,
	CAPS_PASSWORD,
	JOINED_NAME,
	KEY_RUN,
	SCHEME,
	SCHEME_WORD,
	DOTTED,
	LINE_REFERENCE,
	PASSPHRASE_WORDS,
	UUID,
	USERINFO,
	USERINFO_EXAMPLE,
};

/** A line `credentialLineHits` flags: a credential key, or the name of a credential shape. */
export interface LineHit {
	readonly line: number;
	readonly key: string;
	/** A hard credential shape, which can never be allowed. */
	readonly shape: boolean;
}

/**
 * Where each line of `text` holds a credential-looking value: a
 * credential-shaped value anywhere (`key` is the shape's name), or a literal
 * under a credential key (`key` is the key). A YAML block or `"""` value is
 * reported at its line. Every text file is checked by key: settings, code
 * and prose. Every finding on a line is listed, each (line, key) once.
 * Never returns a value.
 */
export function credentialLineHits(text: string, rel: string): LineHit[] {
	const kind: TextKind = CODE_TEXT.test(rel) ? "code" : SETTINGS_TEXT.test(rel) ? "settings" : "text";
	const lines = text.split("\n");
	let next: Int32Array | undefined;
	/** The index of the first non-empty line after line `i`, or -1. Built once, in one pass. */
	const after = (i: number): number => {
		if (next === undefined) {
			next = new Int32Array(lines.length + 1).fill(-1);
			for (let j = lines.length - 2; j >= 0; j--) next[j] = (lines[j + 1] as string).trim() !== "" ? j + 1 : (next[j + 1] as number);
		}
		return next[i] as number;
	};
	const hits = new Map<string, LineHit>();
	const add = (h: LineHit): void => {
		const id = `${String(h.line)}\0${h.key}`;
		if (!hits.has(id)) hits.set(id, h);
	};
	lines.forEach((line, i) => {
		for (const s of shapesOf(line)) add({ line: i + 1, key: s.name, shape: s.hard });
		for (const k of keyedHits(lines, i, kind, after)) add({ line: k.line, key: k.key, shape: false });
	});
	return [...hits.values()].sort((a, b) => a.line - b.line);
}

/** `line N` for each line of `text` that `credentialLineHits` flags, each line once. Never returns the line. */
export function credentialLines(text: string, rel: string): string[] {
	return [...new Set(credentialLineHits(text, rel).map((h) => `line ${String(h.line)}`))];
}

/** The largest config file the credential scan reads, and so the largest config sync carries. */
export const MAX_SCAN_BYTES = 1024 * 1024;

function readConfigText(file: string): { ok: true; text: string } | { ok: false; reason: string } {
	let text: string;
	try {
		const st = lstatSync(file);
		if (!st.isFile()) return { ok: false, reason: "not a regular file" };
		if (st.size > MAX_SCAN_BYTES) return { ok: false, reason: "larger than 1 MiB, not scanned" };
		text = readFileSync(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
	}
	if (text.includes("\0")) return { ok: false, reason: "binary, not scanned" };
	return { ok: true, text };
}

/** Findings in the text of config file `rel`: JSON that parses by key path and raw shapes, any other text by line. */
function scanText(text: string, rel: string): Finding[] {
	if (/\.json$/i.test(rel)) {
		try {
			return jsonFindings(text, rel);
		} catch {
			// Not JSON after all: scan it as lines.
		}
	}
	return credentialLineHits(text, rel).map((h) => ({ line: h.line, key: h.key, at: `line ${String(h.line)}`, shape: h.shape }));
}

/** Scan one config file: JSON by key path (lines when it does not parse) plus shapes in the raw text, any other text by line. */
export function scanConfigFile(file: string, rel: string): { ok: true; at: string[] } | { ok: false; reason: string } {
	const r = readConfigText(file);
	if (!r.ok) return r;
	return { ok: true, at: [...new Set(scanText(r.text, rel).map((f) => f.at))] };
}

const ENV_COLON = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The dotted key paths of the JSON file `file` whose whole value, trimmed,
 * is `env:VAR`. A reference for some extension configs, so the credential
 * scan does not flag it, but a literal string to Pi and pi-web-access. Empty
 * when the file cannot be read or is not JSON. Never returns the values.
 */
export function envColonPaths(file: string): string[] {
	const r = readConfigText(file);
	if (!r.ok) return [];
	let value: unknown;
	try {
		value = JSON.parse(r.text);
	} catch {
		return [];
	}
	const out: string[] = [];
	const visit = (v: unknown, path: readonly string[]): void => {
		if (Array.isArray(v)) v.forEach((x, i) => visit(x, [...path, String(i)]));
		else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) visit(x, [...path, k]);
		else if (typeof v === "string" && ENV_COLON.test(v.trim())) out.push(path.length === 0 ? "(value)" : path.join("."));
	};
	visit(value, []);
	return out;
}

/** The scrypt parameters of an allow entry: N = 2^14, r = 8, p = 1, 32 bytes out. */
const ALLOW_SCRYPT = { N: 2 ** 14, r: 8, p: 1 } as const;
const ALLOW_DOMAIN = "pi-profile/allow/v1\0";

/**
 * What `sync.allowFindings` matches: scrypt (`ALLOW_SCRYPT`) of
 * `"pi-profile/allow/v1\0" + path + "\0" + key + "\0" + line`, where `line`
 * is the raw line without its newline, with the entry's 16-byte `salt` (32
 * hex digits), as 64 lower-case hex digits. Slow and salted, so an entry
 * left behind does not give away its line to a dictionary.
 */
export function allowDigest(path: string, key: string, line: string, salt: string): string {
	return scryptSync(`${ALLOW_DOMAIN}${path}\0${key}\0${line}`, Buffer.from(salt, "hex"), 32, ALLOW_SCRYPT).toString("hex");
}

type FileScan =
	| { readonly ok: false; readonly reason: string }
	| {
			readonly ok: true;
			readonly kept: readonly Finding[];
			readonly ignored: readonly IgnoredAllow[];
			/** The allow entries that matched a finding. */
			readonly used: readonly AllowFinding[];
			/** The raw text of line `n`, from 1. */
			readonly lineText: (n: number) => string | undefined;
	  };

/**
 * Scan config file `rel` at `abs`, then drop each finding an allow entry
 * matches: the same path, line and key, and the scrypt of that line's text
 * now (`allowDigest`). scrypt runs only for an entry whose path, line and key
 * already match a finding. A hard shape is never dropped, nor is any finding
 * on its line, and an entry on such a line is ignored.
 */
function scanFile(abs: string, rel: string, allow: readonly AllowFinding[]): FileScan {
	const r = readConfigText(abs);
	if (!r.ok) return r;
	return allowScan(r.text, rel, allow);
}

/** `scanFile` over text already read. */
function allowScan(text: string, rel: string, allow: readonly AllowFinding[]): Extract<FileScan, { ok: true }> {
	const findings = scanText(text, rel);
	let lines: string[] | undefined;
	const lineText = (n: number): string | undefined => {
		lines ??= text.split("\n");
		return lines[n - 1];
	};
	const mine = allow.filter((a) => a.path === rel);
	if (mine.length === 0) return { ok: true, kept: findings, ignored: [], used: [], lineText };
	const hardLines = new Set(findings.filter((f) => f.shape).map((f) => f.line));
	const used = new Set<AllowFinding>();
	const matches = new Map<AllowFinding, boolean>();
	const match = (a: AllowFinding): boolean => {
		let m = matches.get(a);
		if (m === undefined) {
			const t = lineText(a.line);
			m = t !== undefined && allowDigest(a.path, a.key, t, a.salt) === a.scrypt;
			matches.set(a, m);
		}
		return m;
	};
	const allowed = (f: Finding): boolean => {
		if (f.shape || hardLines.has(f.line)) return false;
		const a = mine.find((x) => x.line === f.line && x.key === f.key && match(x));
		if (a !== undefined) used.add(a);
		return a !== undefined;
	};
	const kept = findings.filter((f) => !allowed(f));
	return { ok: true, kept, ignored: mine.filter((a) => hardLines.has(a.line)).map((entry) => ({ entry, reason: SHAPE_NEVER_ALLOWED })), used: [...used], lineText };
}

type Check =
	| { readonly ok: true; readonly ignored: readonly IgnoredAllow[]; readonly used: readonly AllowFinding[] }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly findings: readonly Finding[];
			readonly unscanned?: string;
			readonly ignored: readonly IgnoredAllow[];
			readonly used: readonly AllowFinding[];
			readonly lineText?: (line: number) => string | undefined;
	  };

/** `pushable` with a reason that does not name the file, the findings behind a refusal, and the allow entries it ignored. */
function check(profileDir: string, rel: string, rules: SyncRules): Check {
	const no = (reason: string): Check => ({ ok: false, reason, findings: [], ignored: [], used: [] });
	const segs = rel.split("/");
	if (rel === "" || isAbsolute(rel) || rel.includes("\\") || segs.some((s) => s === "" || s === "." || s === "..")) return no("not a plain relative path");
	const root = resolve(profileDir);
	try {
		if (realpathSync(root) !== root) return no("linked-root: the profile directory is reached through a link");
	} catch (error) {
		return no(`profile directory cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	let st: Stats;
	try {
		for (let k = 1; k < segs.length; k++) {
			const parent = lstatSync(join(root, ...segs.slice(0, k)));
			if (!parent.isDirectory()) return no(`${printable(segs.slice(0, k).join("/"))} is not a directory (a link is never followed)`);
		}
		st = lstatSync(join(root, ...segs));
	} catch (error) {
		return no(`cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	const abs = join(root, ...segs);
	const c = entryClass(rel, rules, st, () => textScript(abs));
	if (c.cls !== "config") return no(`class ${c.cls}${c.why === undefined ? "" : `: ${UNKNOWN_REASONS[c.why]}`}`);
	const scan = scanFile(abs, rel, rules.allowFindings ?? []);
	if (!scan.ok) return { ok: false, reason: scan.reason, findings: [], unscanned: scan.reason, ignored: [], used: [] };
	if (scan.kept.length > 0) {
		const at = [...new Set(scan.kept.map((f) => printable(f.at)))];
		return { ok: false, reason: `credential-looking value at ${at.join(", ")}`, findings: scan.kept, ignored: scan.ignored, used: scan.used, lineText: scan.lineText };
	}
	return { ok: true, ignored: scan.ignored, used: scan.used };
}

export type Pushable = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The credential scan of config file `rel` over bytes already read: the
 * check config sync runs on the bytes it actually read and on each staged
 * blob, where no path is left to stat. The bytes must be at most 1 MiB of
 * text, and the scan must find nothing `rules.allowFindings` does not
 * allow. It does not class the path (see `classifyContent`). The reason
 * names the path and finding locations, never a value.
 */
export function scanContent(rel: string, rules: SyncRules, bytes: Buffer): Pushable {
	const no = (reason: string): Pushable => ({ ok: false, reason: `${printable(rel)}: ${reason}` });
	if (bytes.length > MAX_SCAN_BYTES) return no("larger than 1 MiB, not scanned");
	const text = bytes.toString("utf8");
	if (text.includes("\0")) return no("binary, not scanned");
	const scan = allowScan(text, rel, rules.allowFindings ?? []);
	if (scan.kept.length > 0) return no(`credential-looking value at ${[...new Set(scan.kept.map((f) => printable(f.at)))].join(", ")}`);
	return { ok: true };
}

/**
 * Whether config sync may carry the file `rel` of the profile at
 * `profileDir`. `profileDir` itself must not be reached through a link:
 * it is resolved to an absolute path and then realpathed once, and a
 * difference refuses with reason `linked-root`. A link anywhere in the
 * path to the profile could be swapped to point at another directory
 * between this check and the read, so the caller must pass the real path.
 * Then `rel` must be a plain relative path whose parents are real directories,
 * a regular file with one name (nlink 1), of class `config`, whose
 * credential scan found nothing that `rules.allowFindings` does not allow.
 * The reason never holds file contents. A refusal applies to this file only.
 * It checks a path, not an open file: the caller must still open with
 * O_NOFOLLOW and fstat what it reads.
 */
export function pushable(profileDir: string, rel: string, rules: SyncRules): Pushable {
	const c = check(profileDir, rel, rules);
	return c.ok ? { ok: true } : { ok: false, reason: `${printable(rel)}: ${c.reason}` };
}

export interface PushPlan {
	/** Config files config sync may carry. */
	readonly push: readonly string[];
	/** Config files it must skip, each with its reason and findings (locations only). */
	readonly skipped: readonly SkippedFile[];
}

export interface ConfigReport extends PushPlan {
	/** Skipped files with credential-looking values or that could not be scanned. */
	readonly credentials: readonly CredentialFinding[];
	readonly ignored: readonly IgnoredAllow[];
	/** Allow entries that match no finding: the path, line and key only. */
	readonly stale: readonly StaleAllow[];
}

function planEntries(root: string, entries: readonly SurveyEntry[], rules: SyncRules): ConfigReport {
	const push: string[] = [];
	const skipped: SkippedFile[] = [];
	const credentials: CredentialFinding[] = [];
	const ignored: IgnoredAllow[] = [];
	const used = new Set<AllowFinding>();
	for (const e of entries) {
		if (e.cls !== "config" || e.dir || e.link) continue;
		const c = check(root, e.path, rules);
		ignored.push(...c.ignored);
		for (const a of c.ignored) used.add(a.entry);
		for (const a of c.used) used.add(a);
		if (c.ok) {
			push.push(e.path);
			continue;
		}
		skipped.push({ path: e.path, reason: c.reason, findings: c.findings });
		if (c.unscanned !== undefined) credentials.push({ path: e.path, at: [], unscanned: c.unscanned });
		else if (c.findings.length > 0) credentials.push({ path: e.path, at: [...new Set(c.findings.map((f) => f.at))] });
	}
	const stale = (rules.allowFindings ?? []).filter((a) => !used.has(a)).map((a) => ({ path: a.path, line: a.line, key: a.key }));
	return { push, skipped, credentials, ignored, stale };
}

/**
 * What config sync would do with each config file of the profile at
 * `profileDir`: `pushable` for each, one file at a time. A refused file is
 * skipped and listed with its reason; it never stops the others.
 */
export function pushPlan(profileDir: string, rules: SyncRules): PushPlan {
	const root = resolve(profileDir);
	const r = planEntries(root, surveyProfile(root, rules), rules);
	return { push: r.push, skipped: r.skipped };
}

/**
 * `pushPlan` over surveyed `entries` of the profile at `dir`, with the
 * credential findings and ignored allow entries, for `sync status` and
 * doctor. `dir` is realpathed first: a profile that is a link is reported
 * by its target, as config sync must read it.
 */
export function configReport(dir: string, entries: readonly SurveyEntry[], rules: SyncRules): ConfigReport {
	let root = resolve(dir);
	try {
		root = realpathSync(root);
	} catch {
		// `check` reports it for each file.
	}
	return planEntries(root, entries, rules);
}

/**
 * The `sync.allowFindings` entries that would allow line `line` of config
 * file `rel`: one for each finding on that line, with the SHA-256 of the
 * line's text. Refuses a line with no finding, and a line with a hard
 * credential shape, which can never be allowed. Never returns the line.
 */
export function allowEntries(profileDir: string, rel: string, line: number, rules: SyncRules): AllowFinding[] {
	const where = `${printable(rel)}:${String(line)}`;
	const problem = allowPathProblem(rel);
	if (problem !== undefined) throw new Refusal(`${where}: the path ${problem}`);
	let root = resolve(profileDir);
	try {
		root = realpathSync(root);
	} catch (error) {
		throw new Refusal(`profile directory cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	const c = check(root, rel, { ...rules, allowFindings: [] });
	if (c.ok) throw new Refusal(`${printable(rel)}: no credential-looking value; config sync carries it as it is`);
	const here = c.findings.filter((f) => f.line === line);
	const text = c.lineText?.(line);
	if (text === undefined || here.length === 0) throw new Refusal(c.findings.length === 0 ? `${printable(rel)}: ${c.reason}` : `${where}: no credential-looking value on this line (found at ${[...new Set(c.findings.map((f) => printable(f.at)))].join(", ")})`);
	const shapes = here.filter((f) => f.shape);
	if (shapes.length > 0) throw new Refusal(`${where}: a credential shape (${shapes.map((f) => f.key).join(", ")}) can never be allowed; move the value to an environment variable or auth.json`);
	const keys = [...new Set(here.map((f) => f.key))];
	return keys.map((key) => {
		const salt = randomBytes(16).toString("hex");
		return { path: rel, line, key, salt, scrypt: allowDigest(rel, key, text, salt) };
	});
}
