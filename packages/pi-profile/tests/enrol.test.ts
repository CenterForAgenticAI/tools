import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli/main.ts";
import type { SshRunner } from "../src/core/authsync.ts";
import { configPath } from "../src/core/config.ts";
import { initHub, pushHubs } from "../src/core/hub.ts";
import { createProfile } from "../src/core/profiles.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

/**
 * issue 33: pi-profile enrol HOST. This host is "box"; the peer is
 * "kite", a second PI_PROFILE_HOME reached through a stand-in ssh on PATH that
 * runs the remote command here. The hub is a local bare repository. No test
 * uses the network or a real host.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "tests", "fixtures", "cli-source.mjs");
const GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const SECRET = "sk-ENROL-API-SECRET";
const PKG = ["@earendil-works", "pi-coding-agent"] as const;

let me: Sandbox;
let peer: Sandbox;
let tools: string;
let hub: string;
let log: string;

beforeEach(() => {
	me = sandbox();
	peer = sandbox();
	tools = realpathSync(mkdtempSync(join(tmpdir(), "pi-profile-enrol-")));
	hub = join(tools, "hub.git");
	git(["init", "--quiet", "--bare", "--initial-branch=main", hub]);
	log = join(tools, "ssh.log");
	// git alone, so the peer's PATH holds nothing else of this machine (no real node, pi or pi-profile).
	mkdirSync(join(tools, "git-bin"));
	symlinkSync(GIT, join(tools, "git-bin", "git"));
	mkdirSync(join(tools, "ssh-bin"));
	writeFileSync(
		join(tools, "ssh-bin", "ssh"),
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" >> "$SSH_LOG"',
			'printf "%s\\n" "----" >> "$SSH_LOG"',
			'while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; -*) echo "unexpected option $1" >&2; exit 64;; *) break;; esac; done',
			'host="$1"; shift',
			'case "$host" in',
			'  kite) H="$PEER_HOME"; P="$PEER_PATH"; ID="${PEER_HOST_ID-kite}"; S="$PEER_SHELL";;',
			'  box) H="$LOCAL_HOME"; P="$LOCAL_PATH"; ID=box; S=/bin/bash;;',
			'  hostkey) echo "Host key verification failed." >&2; exit 255;;',
			'  *) echo "ssh: Could not resolve hostname $host: Name or service not known" >&2; exit 255;;',
			"esac",
			'export HOME="$H" PATH="$P" SHELL="$S"',
			// An empty PEER_HOST_ID: the peer works out its own host ID (tailscale, then its hostname).
			'if [ "$1" = pi-profile ]; then shift; export PI_PROFILE_HOME="$H"; if [ -n "$ID" ]; then export PI_PROFILE_HOST_ID="$ID"; else unset PI_PROFILE_HOST_ID; fi; exec "$NODE_BIN" "$CLI" "$@"; fi',
			'exec /bin/sh -c "$*"',
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
});
afterEach(() => {
	me.cleanup();
	peer.cleanup();
	rmSync(tools, { recursive: true, force: true });
});

function git(args: readonly string[]): string {
	const r = spawnSync("git", [...args], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

interface PeerTools {
	/** What node --version prints; null: no node. */
	readonly node?: string | null;
	readonly piProfile?: boolean;
	/** The Pi version of an npm global install; null: no pi. */
	readonly pi?: string | null;
}

/** The peer's PATH: the stand-in ssh, then the tools asked for, then git. */
function peerPath(t: PeerTools = {}): string {
	const bin = join(tools, "peer-bin");
	rmSync(bin, { recursive: true, force: true });
	mkdirSync(bin);
	const node = t.node === undefined ? "v24.3.0" : t.node;
	if (node !== null) writeFileSync(join(bin, "node"), `#!/bin/sh\necho ${node}\n`, { mode: 0o755 });
	if (t.piProfile !== false) writeFileSync(join(bin, "pi-profile"), '#!/bin/sh\nexec "$NODE_BIN" "$CLI" "$@"\n', { mode: 0o755 });
	const dirs = [join(tools, "ssh-bin"), bin];
	const pi = t.pi === undefined ? "1.0.0" : t.pi;
	if (pi !== null) {
		const root = join(tools, "peer-npm");
		rmSync(root, { recursive: true, force: true });
		const pkg = join(root, "lib", "node_modules", ...PKG);
		mkdirSync(join(pkg, "dist"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: pi }));
		writeFileSync(join(pkg, "dist", "cli.js"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
		mkdirSync(join(root, "bin"));
		symlinkSync("../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", join(root, "bin", "pi"));
		dirs.push(join(root, "bin"));
	}
	dirs.push(join(tools, "git-bin"));
	return dirs.join(":");
}

/** The environment of pi-profile on this host. */
function envOf(t: PeerTools = {}, shell = "/usr/bin/fish"): Record<string, string> {
	const local = [join(tools, "ssh-bin"), join(tools, "git-bin")].join(":");
	return {
		PATH: local,
		HOME: me.home,
		PI_PROFILE_HOME: me.home,
		PI_PROFILE_HOST_ID: "box",
		SSH_LOG: log,
		PEER_HOME: peer.home,
		PEER_PATH: peerPath(t),
		PEER_SHELL: shell,
		LOCAL_HOME: me.home,
		LOCAL_PATH: local,
		NODE_BIN: process.execPath,
		CLI,
	};
}

const coreEnv = (): Record<string, string | undefined> => ({ HOME: me.home, PI_PROFILE_HOME: me.home, PI_PROFILE_HOST_ID: "box", PATH: process.env.PATH });

function cli(args: readonly string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 120_000 });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** This host pushes profile p (separate auth, with a key here) to the hub. */
function hubWithProfile(): void {
	const dir = createProfile(me.l, "p", { auth: "separate" }).dir;
	writeFileSync(join(dir, "AGENTS.md"), "# Agents\n\nBe brief.\n");
	writeFileSync(join(dir, "auth.json"), `${JSON.stringify({ anthropic: { type: "api_key", key: SECRET } })}\n`, { mode: 0o600 });
	initHub(me.l, hub, { env: coreEnv() });
	const r = pushHubs(me.l, ["p"], { env: coreEnv() });
	assert.deepEqual(r.hubs.filter((h) => h.failed !== undefined), []);
}

/** Every file, link and folder under root, by content: a byte-for-byte picture of a host's state. */
function snapshot(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const st = lstatSync(path);
			const rel = path.slice(root.length);
			if (st.isSymbolicLink()) out[rel] = `link ${readlinkSync(path)}`;
			else if (st.isDirectory()) {
				out[rel] = "dir";
				walk(path);
			} else out[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(root);
	return out;
}

const peerConfig = (): unknown => JSON.parse(readFileSync(configPath(peer.l), "utf8"));
const sshCalls = (): string[][] => (existsSync(log) ? readFileSync(log, "utf8").split("----\n").filter((x) => x.length > 0).map((x) => x.split("\n").filter((y) => y.length > 0)) : []);
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "--"];

describe("enrol HOST: a fresh peer", () => {
	it("checks the peer, writes its machine config, inits the hub, pulls the profiles and prints the shell-init line", () => {
		hubWithProfile();
		const store = join(peer.home, "sessions");
		const r = cli(["enrol", "kite", "--remote", hub, "--session-store", store], envOf());
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.deepEqual(peerConfig(), { schemaVersion: 1, hostId: "kite", sessionStores: { main: { path: store } }, defaultSessionStore: "main", hubs: { default: { remote: hub } } });
		assert.equal(readFileSync(join(peer.home, "profiles", "p", "AGENTS.md"), "utf8"), "# Agents\n\nBe brief.\n");
		assert.match(r.stdout, /^kite: prerequisites: ok: Node v24\.3\.0/m);
		assert.match(r.stdout, /^kite: config: done: /m);
		assert.match(r.stdout, /^kite: hub: done: /m);
		assert.match(r.stdout, /^kite: pull: done: .*\bp\b/m);
		assert.match(r.stdout, /^kite: pi: skipped: /m);
		// The peer's login shell is fish, so its line, and only its line, is printed.
		assert.match(r.stdout, /pi-profile shell-init fish \| source/);
		assert.doesNotMatch(r.stdout, /shell-init bash/);
		// The probe, then one fixed-word pi-profile command; never a secret, never an unchecked word.
		const calls = sshCalls();
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0]?.slice(0, 10), [...SSH_OPTS, "kite"]);
		assert.deepEqual(calls[1], [...SSH_OPTS, "kite", "pi-profile", "enrol", "--local", "--hub", "default", "--remote", hub, "--session-store", store]);
		assert.ok(!readFileSync(log, "utf8").includes(SECRET));
		assert.ok(!(r.stdout + r.stderr).includes(SECRET));
		// Nothing secret went to the peer: enrol never copies auth.json.
		assert.ok(!readFileSync(join(peer.home, "profiles", "p", "auth.json"), "utf8").includes(SECRET));
	});

	it("prints all three shell-init lines when the peer's login shell is none of fish, bash or zsh", () => {
		hubWithProfile();
		const r = cli(["enrol", "kite", "--remote", hub], envOf({}, "/bin/tcsh"));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		for (const s of ["fish", "bash", "zsh"]) assert.match(r.stdout, new RegExp(`shell-init ${s}`));
	});

	it("a second enrol reports every step already in place and leaves the peer byte-for-byte as it was", () => {
		hubWithProfile();
		const env = envOf();
		const store = join(peer.home, "sessions");
		assert.equal(cli(["enrol", "kite", "--remote", hub, "--session-store", store], env).status, 0);
		const before = snapshot(peer.home);
		const r = cli(["enrol", "kite", "--remote", hub, "--session-store", store], env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		for (const step of ["config", "hub", "pull"]) assert.match(r.stdout, new RegExp(`^kite: ${step}: already: `, "m"));
		assert.doesNotMatch(r.stdout, /: done: /);
		assert.deepEqual(snapshot(peer.home), before);
	});

	it("--dry-run writes nothing on either host and says what would happen", () => {
		hubWithProfile();
		const env = envOf();
		const peerBefore = snapshot(peer.home);
		const meBefore = snapshot(me.home);
		const hubBefore = snapshot(hub);
		const r = cli(["enrol", "kite", "--remote", hub, "--session-store", join(peer.home, "sessions"), "--auth", "pull", "--dry-run"], env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: config: done: would write/m);
		assert.match(r.stdout, /^kite: hub: done: would run sync init/m);
		assert.match(r.stdout, /would run on kite: pi-profile auth pull box/);
		assert.deepEqual(snapshot(peer.home), peerBefore);
		assert.deepEqual(snapshot(me.home), meBefore);
		assert.deepEqual(snapshot(hub), hubBefore);
		assert.equal(sshCalls().filter((c) => c.includes("auth")).length, 0);
	});

	it("--dry-run on an enrolled peer after the hub moved changes no config, profile, sync state or mirror main; it fetches only, and a real run then pulls", () => {
		hubWithProfile();
		const env = envOf();
		assert.equal(cli(["enrol", "kite", "--remote", hub], env).status, 0);
		writeFileSync(join(me.home, "profiles", "p", "AGENTS.md"), "# Agents\n\nBe briefer.\n");
		assert.deepEqual(pushHubs(me.l, ["p"], { env: coreEnv() }).hubs.filter((h) => h.failed !== undefined), []);
		const mirror = join(peer.home, "pi-profile", "sync", "default.git");
		const ref = (name: string): string => git(["--git-dir", mirror, "rev-parse", name]).trim();
		const picture = (): unknown => ({
			config: readFileSync(configPath(peer.l), "utf8"),
			profiles: snapshot(join(peer.home, "profiles")),
			state: snapshot(join(peer.home, "pi-profile", "state")),
			main: ref("refs/heads/main"),
		});
		const before = picture();
		const fetchedBefore = ref("refs/remotes/origin/main");
		const r = cli(["enrol", "kite", "--remote", hub, "--dry-run"], env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: pull: done: would pull p\b/m);
		assert.deepEqual(picture(), before);
		// The dry run fetched the hub into the mirror, as sync pull --dry-run does (the documented exception).
		assert.notEqual(ref("refs/remotes/origin/main"), fetchedBefore);
		const real = cli(["enrol", "kite", "--remote", hub], env);
		assert.equal(real.status, 0, real.stdout + real.stderr);
		assert.match(real.stdout, /^kite: pull: done: pulled p\b/m);
		assert.equal(readFileSync(join(peer.home, "profiles", "p", "AGENTS.md"), "utf8"), "# Agents\n\nBe briefer.\n");
	});
});

describe("enrol HOST: the peer's own host ID is not a safe name", () => {
	/** The peer has no PI_PROFILE_HOST_ID, and its tailscale reports a DNSName whose short name has an underscore. */
	function unsafePeerEnv(): Record<string, string> {
		const env = envOf();
		const bin = join(tools, "tailscale-bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "tailscale"), `#!/bin/sh\necho '${JSON.stringify({ Self: { DNSName: "my_laptop.tail1234.ts.net." } })}'\n`, { mode: 0o755 });
		return { ...env, PEER_HOST_ID: "", PEER_PATH: `${bin}:${env.PEER_PATH}` };
	}
	const hostIn = (stdout: string): string | undefined => /^kite: config: done: (?:would write|wrote) machine config: host ID ([^,\n]+)/m.exec(stdout)?.[1];

	it("without --host-id: refused (exit 2) naming --host-id; nothing is written there", () => {
		hubWithProfile();
		const before = snapshot(peer.home);
		const r = cli(["enrol", "kite", "--remote", hub], unsafePeerEnv());
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: config: failed: host ID is not a safe path segment: my_laptop; give one with --host-id/m);
		assert.deepEqual(snapshot(peer.home), before);
	});

	it("with --host-id kite: the dry run and the real run report the same host, and the real run writes hostId kite (exit 0)", () => {
		hubWithProfile();
		const env = unsafePeerEnv();
		const dry = cli(["enrol", "kite", "--remote", hub, "--host-id", "kite", "--dry-run"], env);
		assert.equal(dry.status, 0, dry.stdout + dry.stderr);
		const r = cli(["enrol", "kite", "--remote", hub, "--host-id", "kite"], env);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(hostIn(dry.stdout), "kite", dry.stdout);
		assert.equal(hostIn(r.stdout), hostIn(dry.stdout), r.stdout);
		assert.match(r.stdout, /^kite: config: done: wrote machine config: host ID kite$/m);
		assert.equal((peerConfig() as { hostId?: string }).hostId, "kite");
		assert.match(r.stdout, /^kite: pull: done: pulled p\b/m);
	});

	it("enrol --local --host-id kite on that peer writes hostId kite (exit 0)", () => {
		hubWithProfile();
		const env = unsafePeerEnv();
		const peerEnv: Record<string, string> = { PATH: env.PEER_PATH as string, HOME: peer.home, PI_PROFILE_HOME: peer.home };
		const r = cli(["enrol", "--local", "--remote", hub, "--host-id", "kite"], peerEnv);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		const report = JSON.parse(r.stdout) as { host: string; steps: Array<{ step: string; status: string }> };
		assert.equal(report.host, "kite");
		assert.deepEqual(report.steps.find((s) => s.step === "config")?.status, "done");
		assert.equal((peerConfig() as { hostId?: string }).hostId, "kite");
	});
});

describe("enrol HOST: the peer is not ready", () => {
	const cases: Array<[string, PeerTools, RegExp]> = [
		["no node", { node: null }, /Node is not on the PATH[\s\S]*nvm install 24/],
		["an old node", { node: "v22.11.0" }, /Node v22\.11\.0 is too old[\s\S]*nvm install 24/],
		["no pi-profile", { piProfile: false }, /pi-profile is not on the PATH[\s\S]*npm install -g @centerforagenticai\/pi-profile/],
		["no pi", { pi: null }, /Pi is not on the PATH[\s\S]*npm install --global @earendil-works\/pi-coding-agent/],
	];
	for (const [what, t, re] of cases) {
		it(`${what}: stops before anything is written there (exit 2) and prints the command to run`, () => {
			hubWithProfile();
			const before = snapshot(peer.home);
			const r = cli(["enrol", "kite", "--remote", hub], envOf(t));
			assert.equal(r.status, 2, r.stdout + r.stderr);
			assert.match(r.stderr, re);
			assert.match(r.stderr, /nothing was written/);
			assert.deepEqual(snapshot(peer.home), before);
			// Only the read-only probe ran.
			assert.equal(sshCalls().length, 1);
			assert.ok(!sshCalls()[0]?.includes("pi-profile"));
		});
	}

	it("a Pi that does not match the hub's Pi version pin is a warning: enrolment goes on", () => {
		hubWithProfile();
		const io = captureIo(coreEnv());
		assert.equal(main(["pin", "^9.0.0"], io), 0, io.stderr);
		assert.deepEqual(pushHubs(me.l, ["p"], { env: coreEnv() }).hubs.filter((h) => h.failed !== undefined), []);
		const r = cli(["enrol", "kite", "--remote", hub], envOf({ pi: "1.0.0" }));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: pi: warning: Pi 1\.0\.0 does not match the Pi version pin \^9\.0\.0 of hub default/m);
		assert.ok(existsSync(join(peer.home, "profiles", "p", "AGENTS.md")));
	});
});

describe("enrol HOST: refusals", () => {
	it("a peer whose machine config has another host ID is refused; nothing is overwritten", () => {
		hubWithProfile();
		mkdirSync(dirname(configPath(peer.l)), { recursive: true });
		writeFileSync(configPath(peer.l), `${JSON.stringify({ schemaVersion: 1, hostId: "other", sessionStores: {} })}\n`);
		const before = snapshot(peer.home);
		const r = cli(["enrol", "kite", "--remote", hub, "--host-id", "kite"], envOf());
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: config: failed: .*host ID other, not kite/m);
		assert.deepEqual(snapshot(peer.home), before);
	});

	it("a peer whose default session store is elsewhere is refused", () => {
		hubWithProfile();
		mkdirSync(dirname(configPath(peer.l)), { recursive: true });
		writeFileSync(configPath(peer.l), `${JSON.stringify({ schemaVersion: 1, hostId: "kite", sessionStores: { vol: { path: "/srv/sessions" } }, defaultSessionStore: "vol" })}\n`);
		const before = snapshot(peer.home);
		const r = cli(["enrol", "kite", "--remote", hub, "--session-store", "/mnt/other"], envOf());
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: config: failed: .*default session store here is vol/m);
		assert.deepEqual(snapshot(peer.home), before);
	});

	it("a peer hub that follows another remote is refused, never repointed", () => {
		hubWithProfile();
		mkdirSync(dirname(configPath(peer.l)), { recursive: true });
		writeFileSync(configPath(peer.l), `${JSON.stringify({ schemaVersion: 1, hostId: "kite", sessionStores: {}, hubs: { default: { remote: "/srv/other-hub.git" } } })}\n`);
		const before = snapshot(peer.home);
		// --session-store would change the config: the hub is checked before that write.
		const r = cli(["enrol", "kite", "--remote", hub, "--session-store", join(peer.home, "sessions")], envOf());
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: hub: failed: .*already uses \/srv\/other-hub\.git/m);
		assert.doesNotMatch(r.stdout, /config: done/);
		assert.deepEqual(snapshot(peer.home), before);
	});

	it("this host's hub remote is a local path, which the peer cannot reach: refused without --remote, naming the way out", () => {
		hubWithProfile();
		const r = cli(["enrol", "kite"], envOf());
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.ok(r.stderr.includes(`--remote box:${hub}`), r.stderr);
		assert.equal(existsSync(log), false, "ssh must never run");
	});

	it("a host that could be read as an ssh option, or is not a Tailscale short name, is refused before ssh runs", () => {
		hubWithProfile();
		for (const host of ["-oProxyCommand=touch /tmp/pwned", "-v", "Kite", "user@kite", "kite.tail.ts.net", ""]) {
			const r = cli(["enrol", "--remote", hub, "--", host].filter((x) => x !== "--"), envOf());
			assert.equal(r.status, 2, `${host}: ${r.stderr}`);
		}
		assert.equal(existsSync(log), false, "ssh must never run");
	});

	it("a remote, host ID or store path a remote shell could read as code is refused before ssh runs", () => {
		hubWithProfile();
		for (const extra of [["--remote", "kite:$(touch pwned)"], ["--remote", "kite:a;b"], ["--remote", hub, "--host-id", "Kite;x"], ["--remote", hub, "--session-store", "/a b"], ["--remote", hub, "--session-store", "relative"], ["--remote", "gitlab.com:x.git"]]) {
			const r = cli(["enrol", "kite", ...extra], envOf());
			assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stderr}`);
		}
		assert.equal(existsSync(log), false, "ssh must never run");
	});

	it("ssh's Host key verification failed names the way out", () => {
		const r = cli(["enrol", "hostkey", "--remote", "kite:pi-hub.git"], envOf());
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.match(r.stderr, /Host key verification failed/);
		assert.match(r.stderr, /connect once with ssh hostkey/);
	});

	it("sync pull refusing on the peer is reported as a failed step with the command to run there (exit 2)", () => {
		hubWithProfile();
		const env = envOf();
		assert.equal(cli(["enrol", "kite", "--remote", hub], env).status, 0);
		writeFileSync(join(peer.home, "profiles", "p", "AGENTS.md"), "edited on kite\n");
		writeFileSync(join(me.home, "profiles", "p", "AGENTS.md"), "edited on box\n");
		assert.deepEqual(pushHubs(me.l, ["p"], { env: coreEnv() }).hubs.filter((h) => h.failed !== undefined), []);
		const r = cli(["enrol", "kite", "--remote", hub], env);
		assert.equal(r.status, 2, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: pull: failed: /m);
		assert.match(r.stdout, /p\/AGENTS\.md/);
		assert.match(r.stdout, /run on kite: pi-profile sync pull --dry-run/);
		assert.equal(readFileSync(join(peer.home, "profiles", "p", "AGENTS.md"), "utf8"), "edited on kite\n");
	});
});

describe("enrol HOST: the peer's report is untrusted", () => {
	const PROBE_OUT = "node=v24.3.0\npi=/opt/pi/bin/pi\npi-profile=/opt/bin/pi-profile\nshell=/bin/bash\n";
	const good = { schemaVersion: 1, dryRun: false, host: "kite", hub: "default", steps: [{ step: "config", status: "done", message: "wrote machine config" }], profiles: ["p"] };
	function enrolWith(report: string): ReturnType<typeof captureIo> {
		const run: SshRunner = (args) => (args.includes("enrol") ? { status: 0, stdout: report, stderr: "" } : { status: 0, stdout: PROBE_OUT, stderr: "" });
		const io = Object.assign(captureIo({ PI_PROFILE_HOME: me.home, PI_PROFILE_HOST_ID: "box" }), { ssh: run });
		(io as unknown as { status: number }).status = main(["enrol", "kite", "--remote", "kite:pi-hub.git"], io);
		return io;
	}
	const status = (io: ReturnType<typeof captureIo>): number => (io as unknown as { status: number }).status;

	it("a well-formed report is printed with control characters made harmless", () => {
		const io = enrolWith(JSON.stringify({ ...good, steps: [{ step: "config", status: "done", message: "ok\u001b[2J\u202e" }] }));
		assert.equal(status(io), 0, io.stderr);
		assert.match(io.stdout, /kite: config: done: ok\?\[2J\?/);
		assert.ok(!(io.stdout + io.stderr).includes("\u001b") && !(io.stdout + io.stderr).includes("\u202e"));
	});

	const hostile: Array<[string, string]> = [
		["not JSON", "EVIL\u001b[2J not json"],
		["an unknown key", JSON.stringify({ ...good, evil: "EVIL\u001b[2J" })],
		["an unknown step", JSON.stringify({ ...good, steps: [{ step: "EVIL", status: "done", message: "x" }] })],
		["an unknown status", JSON.stringify({ ...good, steps: [{ step: "config", status: "EVIL", message: "x" }] })],
		["a profile name that is a path", JSON.stringify({ ...good, profiles: ["../EVIL"] })],
		["another hub", JSON.stringify({ ...good, hub: "EVIL" })],
		["a dry run nobody asked for", JSON.stringify({ ...good, dryRun: true, steps: [{ step: "config", status: "done", message: "EVIL" }] })],
		["an oversized report", `${JSON.stringify({ ...good, steps: [{ step: "config", status: "done", message: "EVIL" }] })}${" ".repeat(300 * 1024)}`],
	];
	for (const [what, report] of hostile) {
		it(`${what} is refused (exit 2) and nothing from it is printed`, () => {
			const io = enrolWith(report);
			assert.equal(status(io), 2, io.stdout + io.stderr);
			assert.ok(!(io.stdout + io.stderr).includes("EVIL"), io.stdout + io.stderr);
			assert.ok(!(io.stdout + io.stderr).includes("\u001b"));
			assert.match(io.stderr, /enrol report/);
		});
	}
});

describe("enrol HOST --auth pull", () => {
	it("runs auth pull on the peer, from this host, for each pulled profile; no secret is in argv or output", () => {
		hubWithProfile();
		const r = cli(["enrol", "kite", "--remote", hub, "--auth", "pull"], envOf());
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: auth pull p: anthropic: added$/m);
		const peerAuth = JSON.parse(readFileSync(join(peer.home, "profiles", "p", "auth.json"), "utf8")) as Record<string, { key?: string }>;
		assert.equal(peerAuth.anthropic?.key, SECRET);
		const calls = sshCalls();
		assert.ok(calls.some((c) => c.join(" ") === [...SSH_OPTS, "kite", "pi-profile", "auth", "pull", "box", "--profile", "p"].join(" ")), JSON.stringify(calls));
		// The peer fetched with auth export over its own ssh back to this host.
		assert.ok(calls.some((c) => c.join(" ") === [...SSH_OPTS, "box", "pi-profile", "auth", "export", "--profile", "p"].join(" ")), JSON.stringify(calls));
		assert.ok(!readFileSync(log, "utf8").includes(SECRET));
		assert.ok(!(r.stdout + r.stderr).includes(SECRET));
	});

	it("a peer that cannot reach this host is reported with the commands to run instead (exit 1)", () => {
		hubWithProfile();
		// This host's ID comes from its machine config first; the peer cannot resolve this one.
		const config = JSON.parse(readFileSync(configPath(me.l), "utf8")) as Record<string, unknown>;
		writeFileSync(configPath(me.l), `${JSON.stringify({ ...config, hostId: "unreachable" })}\n`);
		const r = cli(["enrol", "kite", "--remote", hub, "--auth", "pull"], envOf());
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.match(r.stdout, /^kite: auth pull p: failed: .*Could not resolve hostname unreachable/m);
		assert.match(r.stdout, /run on kite: pi-profile auth pull unreachable --profile p/);
		assert.match(r.stdout, /or from here: pi-profile auth push kite --profile p/);
		assert.ok(!(r.stdout + r.stderr).includes(SECRET));
	});

	it("--auth takes only pull", () => {
		const r = cli(["enrol", "kite", "--remote", hub, "--auth", "push"], envOf());
		assert.equal(r.status, 2);
		assert.equal(existsSync(log), false);
	});
});
