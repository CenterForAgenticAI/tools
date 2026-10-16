import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import {
	advertise,
	advertisedPath,
	discover,
	loadAdvertised,
	onlinePeers,
	parseAdvertised,
	printable,
	REMOTE_READ,
	spawnDiscoverRunner,
	sshArgs,
	type DiscoverRunner,
	type Spawn,
} from "../src/core/repo.ts";
import { Refusal } from "../src/core/result.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const env = (): Record<string, string> => ({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "box" });
const now = new Date("2026-10-05T12:00:00Z");

type Node = { DNSName: unknown; Online: unknown; UserID?: number; Tags?: string[] };
function status(peers: Record<string, Node>, self: Partial<Node> = {}): string {
	return JSON.stringify({ Self: { DNSName: "box.tail.ts.net.", UserID: 1, ...self }, Peer: peers });
}

/** A fake tailnet: the peers that are online and what each answers over SSH. */
function fakeNet(peers: Record<string, { status: number | null; stdout: string; error?: string }>, asked: string[] = []): DiscoverRunner {
	return {
			tailscaleStatus: () => status(Object.fromEntries(Object.keys(peers).map((h, i) => [`k${String(i)}`, { DNSName: `${h}.tail.ts.net.`, Online: true, UserID: 1 }]))),
		readRemote: (host) => {
			asked.push(host);
			return peers[host] ?? { status: 255, stdout: "", error: "no route" };
		},
	};
}

const adv = (repos: Record<string, string>): string =>
	JSON.stringify({ schemaVersion: 1, repositories: Object.fromEntries(Object.entries(repos).map(([id, path]) => [id, { path }])) });

describe("repo advertise", () => {
	it("creates repository.json and hosts/, and adds the repository to advertised.json", () => {
		const path = join(s.home, "repo");
		const r = advertise(s.l, "studio", path, env(), undefined, now);
		assert.equal(r.created, true);
		const info = JSON.parse(readFileSync(join(path, "repository.json"), "utf8")) as unknown;
		assert.deepEqual(info, { schemaVersion: 1, id: "studio", ownerHost: "box", createdAt: "2026-10-05T12:00:00.000Z" });
		assert.ok(statSync(join(path, "hosts")).isDirectory());
		assert.deepEqual(loadAdvertised(s.l), { schemaVersion: 1, repositories: { studio: { path } } });
		assert.equal(statSync(advertisedPath(s.l)).mode & 0o777, 0o600);
	});

	it("adopts an existing repository with the same ID and owner, and keeps its createdAt", () => {
		const path = join(s.home, "repo");
		advertise(s.l, "studio", path, env(), undefined, now);
		writeFileSync(advertisedPath(s.l), adv({}));
		const r = advertise(s.l, "studio", path, env(), undefined, new Date("2030-01-01T00:00:00Z"));
		assert.equal(r.created, false);
		assert.equal(r.repository.createdAt, "2026-10-05T12:00:00.000Z");
	});

	it("refuses a directory owned by another host, or holding another repository", () => {
		const path = join(s.home, "repo");
		mkdirSync(path);
		const foreign = { schemaVersion: 1, id: "studio", ownerHost: "laptop", createdAt: "x" };
		writeFileSync(join(path, "repository.json"), JSON.stringify(foreign));
		assert.throws(() => advertise(s.l, "studio", path, env()), /owned by host laptop, not box/);
		assert.throws(() => advertise(s.l, "other", path, env()), /already repository studio/);
		assert.deepEqual(JSON.parse(readFileSync(join(path, "repository.json"), "utf8")), foreign, "never overwritten");
		assert.deepEqual(loadAdvertised(s.l).repositories, {});
		writeFileSync(join(path, "repository.json"), "{}");
		assert.throws(() => advertise(s.l, "studio", path, env()), /not a pi-profile repository.json/);
	});

	it("refuses a duplicate ID, a duplicate path, a bad ID, a relative path and a file", () => {
		const path = join(s.home, "repo");
		advertise(s.l, "studio", path, env());
		assert.throws(() => advertise(s.l, "studio", join(s.home, "elsewhere"), env()), /already advertised: studio/);
		assert.throws(() => advertise(s.l, "again", path, env()), /already advertised as studio/);
		assert.throws(() => advertise(s.l, "-x", join(s.home, "a"), env()), /invalid repository ID/);
		assert.throws(() => advertise(s.l, "rel", "repo", env()), /must be absolute/);
		assert.throws(() => advertise(s.l, "nl", `${s.home}/a\nb`, env()), /control or format characters/);
		const file = join(s.home, "file");
		writeFileSync(file, "");
		assert.throws(() => advertise(s.l, "f", file, env()), /not a directory/);
	});

	it("normalises the path, so a trailing slash is the same directory", () => {
		const path = join(s.home, "repo");
		advertise(s.l, "studio", `${path}/./`, env());
		assert.deepEqual(loadAdvertised(s.l).repositories, { studio: { path } });
		assert.throws(() => advertise(s.l, "again", `${path}/`, env()), /already advertised as studio/);
	});

	it("accepts a root that is a symlink to a directory", () => {
		const real = join(s.home, "volume");
		mkdirSync(real);
		const link = join(s.home, "link");
		symlinkSync(real, link);
		assert.equal(advertise(s.l, "vol", link, env()).created, true);
		assert.ok(statSync(join(real, "repository.json")).isFile());
	});

	it("refuses when advertised.json changes while it is being updated, keeping the other change", () => {
		const other = adv({ theirs: "/elsewhere" });
		assert.throws(
			() => advertise(s.l, "studio", join(s.home, "repo"), env(), undefined, now, { afterRead: () => writeFileSync(advertisedPath(s.l), other) }),
			/advertised\.json changed while pi-profile was/,
		);
		assert.equal(readFileSync(advertisedPath(s.l), "utf8"), other);
	});

	it("names advertised.json when it is not valid JSON", () => {
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(advertisedPath(s.l), "{ nope");
		assert.throws(() => advertise(s.l, "studio", join(s.home, "repo"), env()), (e) => !(e instanceof Refusal) && /advertised\.json is not valid JSON/.test((e as Error).message));
	});

	it("never prints a rejected path's control characters", () => {
		assert.throws(() => parseAdvertised({ schemaVersion: 1, repositories: { a: { path: "\u001b[2Jrel" } } }), (e) => /control or format/.test((e as Error).message) && !(e as Error).message.includes("\u001b"));
	});

	it("takes the owner from config.json when set", () => {
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(join(s.home, "pi-profile", "config.json"), JSON.stringify({ schemaVersion: 1, hostId: "cfg", sessionStores: {} }));
		assert.equal(advertise(s.l, "r", join(s.home, "repo"), env()).repository.ownerHost, "cfg");
	});
});

describe("advertised.json from a peer is untrusted", () => {
	it("copies only id and path, and rejects anything malformed", () => {
		const parsed = parseAdvertised({ schemaVersion: 1, extra: 1, repositories: { a: { path: "/r", evil: "x" } } });
		assert.deepEqual(parsed, { schemaVersion: 1, repositories: { a: { path: "/r" } } });
		for (const bad of [
			null,
			[],
			{ schemaVersion: 2, repositories: {} },
			{ schemaVersion: 1, repositories: [] },
			{ schemaVersion: 1, repositories: { "../x": { path: "/r" } } },
			{ schemaVersion: 1, repositories: { a: "/r" } },
			{ schemaVersion: 1, repositories: { a: { path: "rel" } } },
			{ schemaVersion: 1, repositories: { a: { path: "/r\u001b[2J" } } },
			{ schemaVersion: 1, repositories: { a: { path: "/r\u202e" } } },
		]) assert.throws(() => parseAdvertised(bad), Refusal);
	});
});

describe("repo discover", () => {
	it("lists only this user's online peers with safe names, never this host, sorted and once each", () => {
		const json = status({
			a: { DNSName: "zeta.tail.ts.net.", Online: true, UserID: 1 },
			b: { DNSName: "Alpha.tail.ts.net.", Online: true, UserID: 1 },
			c: { DNSName: "off.tail.ts.net.", Online: false, UserID: 1 },
			d: { DNSName: "-oProxyCommand=x.tail.ts.net.", Online: true, UserID: 1 },
			f: { DNSName: "alpha.other.ts.net.", Online: true, UserID: 1 },
			g: { DNSName: 7, Online: true, UserID: 1 },
			h: { DNSName: "someone-elses-server.tail.ts.net.", Online: true, UserID: 2 },
			i: { DNSName: "untagged-no-user.tail.ts.net.", Online: true },
			j: { DNSName: "tagged-same-user.tail.ts.net.", Online: true, UserID: 1, Tags: ["tag:server"] },
		});
		assert.deepEqual(onlinePeers(json), [{ host: "alpha" }, { host: "zeta" }]);
		assert.deepEqual(onlinePeers(JSON.stringify({ Self: { UserID: 1 } })), []);
		assert.throws(() => onlinePeers("{}"), /no Self.UserID/);
		assert.throws(() => onlinePeers("nope"), /did not return JSON/);
		assert.throws(() => onlinePeers("[]"), /did not return an object/);
		assert.ok(!(() => { try { onlinePeers("nope"); } catch (e) { return e instanceof Refusal; } return true; })(), "a broken tailscale is an error, not a refusal");
	});

	it("refuses to run on a tagged device, whose user is shared by every tagged server", () => {
		const json = status({ a: { DNSName: "others-server.tail.ts.net.", Online: true, UserID: 9, Tags: ["tag:x"] } }, { UserID: 9, Tags: ["tag:x"] });
		assert.throws(() => onlinePeers(json), (e) => e instanceof Refusal && /tagged Tailscale device/.test(e.message));
		assert.deepEqual(onlinePeers(status({}, { UserID: 9, Tags: [] })), [], "an empty Tags list is not tagged");
	});

	it("reports this host's repositories, each peer's, and why a peer was skipped", () => {
		advertise(s.l, "local", join(s.home, "repo"), env());
		const asked: string[] = [];
		const net = fakeNet(
			{
				studio: { status: 0, stdout: adv({ big: "/Volumes/big/sessions" }) },
				laptop: { status: 0, stdout: "" },
				phone: { status: 255, stdout: "", error: "Connection refused" },
				liar: { status: 0, stdout: adv({ "../x": "/r" }) },
				esc: { status: 0, stdout: adv({ a: "\u001b]0;pwned\u0007\u001b[2Jrel" }) },
				banner: { status: 255, stdout: "", error: "evil \u001b[2J\u202ebanner" },
				junk: { status: 0, stdout: "not json" },
				crash: { status: null, stdout: "" },
			},
			asked,
		);
		const answers = discover(s.l, env(), net);
		assert.deepEqual(answers, [
			{ host: "box", ok: true, repositories: { local: { path: join(s.home, "repo") } } },
			{ host: "banner", ok: false, error: "evil ?[2J?banner" },
			{ host: "crash", ok: false, error: "ssh exited null" },
			{ host: "esc", ok: false, error: "advertised.json: a path must not contain control or format characters" },
			{ host: "junk", ok: false, error: "advertised.json is not valid JSON" },
			{ host: "laptop", ok: true, repositories: {} },
			{ host: "liar", ok: false, error: 'advertised.json: invalid repository ID: "../x"' },
			{ host: "phone", ok: false, error: "Connection refused" },
			{ host: "studio", ok: true, repositories: { big: { path: "/Volumes/big/sessions" } } },
		]);
		assert.deepEqual(asked, ["banner", "crash", "esc", "junk", "laptop", "liar", "phone", "studio"]);
		for (const a of answers) assert.ok(!a.ok ? !/[\p{Cc}\p{Cf}]/u.test(a.error) : true, `${a.host} error is printable`);
	});

	it("fails when Tailscale cannot be read", () => {
		const net: DiscoverRunner = { tailscaleStatus: () => undefined, readRemote: () => assert.fail("no ssh without peers") };
		assert.throws(() => discover(s.l, env(), net), /cannot read tailscale status/);
	});

	it("runs ssh with no prompts, a timeout, the host after --, and a fixed remote command", () => {
		const calls: Array<[string, readonly string[], Parameters<Spawn>[2]]> = [];
		const spawn: Spawn = (cmd, args, opts) => {
			calls.push([cmd, args, opts]);
			return cmd === "tailscale" ? { status: 0, stdout: "{}" } : { status: 255, stdout: null, stderr: "a\nPermission denied" };
		};
		const runner = spawnDiscoverRunner(spawn);
		assert.equal(runner.tailscaleStatus(), "{}");
		assert.deepEqual(runner.readRemote("studio"), { status: 255, stdout: "", error: "Permission denied" });
		assert.deepEqual(calls[1]?.[0], "ssh");
		assert.deepEqual(calls[1]?.[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", "studio", REMOTE_READ]);
		assert.deepEqual(sshArgs("studio"), calls[1]?.[1]);
		assert.equal(REMOTE_READ, "cat ~/.pi/pi-profile/advertised.json 2>/dev/null; true");
		assert.ok((calls[0]?.[2].maxBuffer ?? 0) >= 64 * 1024 * 1024, "a large tailnet's status fits");
	});

	it("treats a failed or overflowing tailscale as unreadable", () => {
		assert.equal(spawnDiscoverRunner(() => ({ status: null, stdout: null, error: new Error("ENOBUFS") })).tailscaleStatus(), undefined);
		assert.equal(spawnDiscoverRunner(() => ({ status: 1, stdout: "" })).tailscaleStatus(), undefined);
		assert.deepEqual(spawnDiscoverRunner(() => ({ status: null, stdout: null, error: new Error("spawn ssh ENOENT") })).readRemote("x"), { status: null, stdout: "", error: "spawn ssh ENOENT" });
	});

	it("printable replaces control and bidi characters", () => {
		assert.equal(printable("a\u001b[2Jb\u0007c\u202ed\u2066e"), "a?[2Jb?c?d?e");
		assert.equal(printable("plain /path ok"), "plain /path ok");
	});
});

describe("repo cli", () => {
	function cli(net: DiscoverRunner | undefined, ...argv: string[]) {
		const io = { ...captureIo(env()), ...(net === undefined ? {} : { discover: net }) };
		const out = { stdout: "", stderr: "" };
		const code = main(argv, { ...io, out: (t) => (out.stdout += t), err: (t) => (out.stderr += t) });
		return { code, ...out };
	}

	it("advertise, list and discover", () => {
		const path = join(s.home, "repo");
		let r = cli(undefined, "repo", "advertise", "studio", path);
		assert.equal(r.code, 0);
		assert.equal(r.stdout, `created and advertised repository: studio (${path}, owner box)\n`);
		writeFileSync(advertisedPath(s.l), adv({}));
		assert.match(cli(undefined, "repo", "advertise", "studio", path).stdout, /^advertised existing repository: studio/);
		assert.equal(cli(undefined, "repo", "list").stdout, `studio\t${path}\n`);
		r = cli(fakeNet({ peer: { status: 0, stdout: adv({ big: "/big" }) }, phone: { status: 255, stdout: "", error: "refused" } }), "repo", "discover");
		assert.equal(r.code, 0);
		assert.equal(r.stdout, `box\tstudio\t${path}\npeer\tbig\t/big\n`);
		assert.equal(r.stderr, "phone: skipped: refused\n");
	});

	it("refuses bad usage with exit 2", () => {
		assert.equal(cli(undefined, "repo").code, 2);
		assert.equal(cli(undefined, "repo", "advertise", "x").code, 2);
		assert.equal(cli(undefined, "repo", "list", "extra").code, 2);
		assert.equal(cli(undefined, "repo", "discover", "extra").code, 2);
		assert.equal(cli({ tailscaleStatus: () => undefined, readRemote: () => ({ status: 0, stdout: "" }) }, "repo", "discover").code, 1);
	});
});
