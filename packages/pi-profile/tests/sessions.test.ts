import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli/main.ts";
import { createProfile } from "../src/core/profiles.ts";
import { configPath, loadConfig, parseConfig, hostId, updateConfig } from "../src/core/config.ts";
import { addStore, checkStore, removeStore, useStore } from "../src/core/sessions.ts";
import { doctor } from "../src/core/doctor.ts";
import { captureIo, sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => { s = sandbox(); });
afterEach(() => { s.cleanup(); });
function cli(...args: string[]) { const io = captureIo({ PI_PROFILE_HOME: s.home, PI_PROFILE_HOST_ID: "test-host" }); return Object.assign(io, { code: main(args, io) }); }

function loadProfileStore(dir: string): string | undefined {
	return (JSON.parse(readFileSync(join(dir, "profile.json"), "utf8")) as { sessions?: { store: string } }).sessions?.store;
}

describe("session stores", () => {
	it("adds, uses and restores a store while preserving settings", () => {
		createProfile(s.l, "work");
		writeFileSync(join(s.home, "profiles", "work", "settings.json"), '{"theme":"dark"}\n');
		assert.equal(cli("sessions", "store", "add", "main", "/sessions").code, 0);
		assert.equal(cli("sessions", "use", "main", "--profile", "work").code, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(s.home, "profiles", "work", "settings.json"), "utf8")), { theme: "dark", sessionDir: "/sessions" });
		assert.equal(cli("sessions", "use", "profile", "--profile", "work").code, 0);
		assert.deepEqual(JSON.parse(readFileSync(join(s.home, "profiles", "work", "settings.json"), "utf8")), { theme: "dark" });
	});
	it("refuses unsafe IDs and relative paths", () => {
		assert.equal(cli("sessions", "store", "add", "profile", "/sessions").code, 2);
		assert.equal(cli("sessions", "store", "add", "main", "relative").code, 2);
		assert.equal(cli("sessions", "store", "add", "main", "/bad\npath").code, 2);
	});
	it("preserves settings mode and reports unknown stores", () => {
		const p = createProfile(s.l, "work");
		chmodSync(join(p.dir, "settings.json"), 0o640);
		writeFileSync(join(p.dir, "profile.json"), JSON.stringify({ schemaVersion: 1, name: "work", auth: { mode: "shared" }, sessions: { store: "missing" } }));
		const findings = doctor(s.l);
		assert.ok(findings.some((f) => f.message.includes("unknown session store: missing")));
		assert.equal(cli("sessions", "use", "missing", "--profile", "work").code, 2);
	});
	it("handles all-profile results, malformed settings, and in-profile links", () => {
		createProfile(s.l, "a");
		createProfile(s.l, "b");
		writeFileSync(join(s.home, "profiles", "b", "settings.json"), "[]\n");
		assert.equal(cli("sessions", "store", "add", "main", "/sessions").code, 0);
		assert.equal(cli("sessions", "use", "main", "--all", "--profile", "a").code, 2);
		assert.equal(cli("sessions", "use", "main", "--all").code, 1);
		assert.equal(JSON.parse(readFileSync(join(s.home, "profiles", "a", "settings.json"), "utf8")).sessionDir, "/sessions");
		const target = join(s.home, "profiles", "a", "settings-target.json");
		writeFileSync(target, "{}\n");
		unlinkSync(join(s.home, "profiles", "a", "settings.json"));
		symlinkSync(target, join(s.home, "profiles", "a", "settings.json"));
		assert.equal(cli("sessions", "use", "profile", "--profile", "a").code, 0);
		assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {});
	});
	it("doctor and store list do not create config on a fresh home", () => {
		assert.deepEqual(loadConfig(s.l, {}), { schemaVersion: 1, sessionStores: {} });
		assert.equal(cli("sessions", "store", "list").code, 0);
		assert.equal(cli("doctor").code, 0);
		assert.equal(existsSync(configPath(s.l)), false);
	});
	it("persists the injected tailscale host name on first store add", () => {
		addStore(s.l, "main", "/sessions", {}, () => '{"Self":{"DNSName":"Box.Example."}}');
		assert.equal(JSON.parse(readFileSync(configPath(s.l), "utf8")).hostId, "box");
	});
	it("preserves settings mode when switching sessions", () => {
		const p = createProfile(s.l, "work");
		chmodSync(join(p.dir, "settings.json"), 0o640);
		assert.equal(cli("sessions", "store", "add", "main", "/sessions").code, 0);
		assert.equal(cli("sessions", "use", "main", "--profile", "work").code, 0);
		assert.equal(statSync(join(p.dir, "settings.json")).mode & 0o777, 0o640);
	});
	it("parses tailscale host names through the injectable runner", () => {
		assert.equal(hostId({}, () => '{"Self":{"DNSName":"box.example."}}'), "box");
		assert.throws(() => hostId({ PI_PROFILE_HOST_ID: "../escape" }), /safe path segment/);
		assert.equal(hostId({}, () => "not json"), hostId({}, () => "{}"));
		assert.equal(hostId({ PI_PROFILE_HOST_ID: "Studio" }), "studio");
	});
	it("refuses unknown config keys and invalid defaults", () => {
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, extra: true }), /extra/);
		assert.throws(() => parseConfig({ schemaVersion: 1, hostId: "h", sessionStores: {}, defaultSessionStore: "none" }), /defaultSessionStore/);
	});
	it("refuses a config.json changed by another writer and keeps that writer's file", () => {
		addStore(s.l, "main", "/sessions", { PI_PROFILE_HOST_ID: "h" });
		const theirs = '{"schemaVersion":1,"hostId":"h","sessionStores":{}}\n';
		assert.throws(() => updateConfig(s.l, (c) => {
			writeFileSync(configPath(s.l), theirs);
			return { ...c, sessionStores: { ...c.sessionStores, other: { path: "/other" } } };
		}, {}), /changed/);
		assert.equal(readFileSync(configPath(s.l), "utf8"), theirs);
	});
	it("refuses a settings.json changed by another writer and keeps that writer's file", () => {
		const p = createProfile(s.l, "work");
		addStore(s.l, "main", "/sessions", { PI_PROFILE_HOST_ID: "h" });
		const settings = join(p.dir, "settings.json");
		const theirs = '{"theme":"pi wrote this"}\n';
		const failed = useStore(s.l, "main", ["work"], {}, { afterSettingsRead: () => writeFileSync(settings, theirs) });
		assert.equal(failed.length, 1);
		assert.equal(readFileSync(settings, "utf8"), theirs);
		assert.equal(loadProfileStore(p.dir), undefined);
	});
	it("restores settings.json byte for byte when profile.json cannot be saved", () => {
		const p = createProfile(s.l, "work");
		addStore(s.l, "main", "/sessions", { PI_PROFILE_HOST_ID: "h" });
		const settings = join(p.dir, "settings.json");
		writeFileSync(settings, '{ "theme":  "dark" }\n');
		const before = readFileSync(settings, "utf8");
		const manifest = join(p.dir, "profile.json");
		const failed = useStore(s.l, "main", ["work"], {}, {
			afterSettingsRead: () => writeFileSync(manifest, readFileSync(manifest, "utf8").replace("}\n", ' }\n')),
		});
		assert.equal(failed.length, 1);
		assert.equal(readFileSync(settings, "utf8"), before);
		assert.equal(loadProfileStore(p.dir), undefined);
	});
	it("doctor warns on a hand-set sessionDir and errors on a disagreeing one", () => {
		const a = createProfile(s.l, "a");
		const b = createProfile(s.l, "b");
		// Not ~/.pi itself: that holds the pulled sessions, which no store may.
		addStore(s.l, "main", join(s.home, "sessions"), { PI_PROFILE_HOST_ID: "h" });
		writeFileSync(join(a.dir, "settings.json"), '{"sessionDir":"/hand/set"}\n');
		assert.deepEqual(useStore(s.l, "main", ["b"]), []);
		writeFileSync(join(b.dir, "settings.json"), '{"sessionDir":"/elsewhere"}\n');
		const findings = doctor(s.l);
		assert.ok(findings.some((f) => f.profile === "a" && f.level === "warn" && f.message.includes("hand-set")));
		assert.ok(findings.some((f) => f.profile === "b" && f.level === "error" && f.message.includes("disagrees")));
	});
	it("doctor reports missing and unwritable stores", () => {
		const ro = join(s.home, "ro");
		mkdirSync(ro);
		chmodSync(ro, 0o500);
		addStore(s.l, "gone", "/does/not/exist", { PI_PROFILE_HOST_ID: "h" });
		addStore(s.l, "ro", ro, { PI_PROFILE_HOST_ID: "h" });
		assert.equal(checkStore(s.home), undefined);
		const messages = doctor(s.l).map((f) => f.message);
		assert.ok(messages.some((m) => m.includes("session store gone does not exist")));
		if (process.getuid?.() !== 0) assert.ok(messages.some((m) => m.includes("session store ro is not writable")));
		chmodSync(ro, 0o700);
	});
	it("removes an unused store and clears it as the default", () => {
		addStore(s.l, "main", "/sessions", { PI_PROFILE_HOST_ID: "h" });
		updateConfig(s.l, (c) => ({ ...c, defaultSessionStore: "main" }), {});
		const c = removeStore(s.l, "main", {});
		assert.deepEqual(c.sessionStores, {});
		assert.equal(c.defaultSessionStore, undefined);
		assert.equal(cli("sessions", "store", "remove", "main").code, 2);
	});
	it("lists stores and refuses unknown sessions subcommands", () => {
		assert.equal(cli("sessions", "store", "add", "main", "/sessions").code, 0);
		const list = cli("sessions", "store", "list");
		assert.equal(list.stdout, "main\t/sessions\n");
		assert.equal(cli("sessions", "frob").code, 2);
		assert.equal(cli("sessions", "store", "frob").code, 2);
	});
	it("refuses removing a store used by a profile", () => {
		createProfile(s.l, "work");
		cli("sessions", "store", "add", "main", "/sessions");
		cli("sessions", "use", "main", "--profile", "work");
		assert.equal(cli("sessions", "store", "remove", "main").code, 2);
	});
});
