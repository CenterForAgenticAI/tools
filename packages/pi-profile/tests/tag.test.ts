import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createProfile } from "../src/core/profiles.ts";
import { lastTag, TAG_TYPE, tagFor, tagToAppend, type EntryLike } from "../src/core/tag.ts";
import piProfile from "../src/index.ts";
import { sandbox, type Sandbox } from "./helpers.ts";

let s: Sandbox;
beforeEach(() => {
	s = sandbox();
});
afterEach(() => {
	s.cleanup();
});

const tagEntry = (profile: string, hostId: string): EntryLike => ({ type: "custom", customType: TAG_TYPE, data: { profile, hostId } });
const here = { profile: "work", hostId: "box" };

function writeConfig(hostId: string): void {
	mkdirSync(join(s.home, "pi-profile"), { recursive: true });
	writeFileSync(join(s.home, "pi-profile", "config.json"), JSON.stringify({ schemaVersion: 1, hostId, sessionStores: {} }));
}

/** Run the extension's session_start handler against a fake Pi and return what it appended. */
function start(env: Record<string, string>, branch: EntryLike[]): Array<[string, unknown]> {
	const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
	const appended: Array<[string, unknown]> = [];
	const api = {
		on: (name: string, h: (e: unknown, ctx: unknown) => void) => handlers.set(name, h),
		registerCommand: () => undefined,
		appendEntry: (type: string, data: unknown) => appended.push([type, data]),
	};
	const saved = { ...process.env };
	Object.assign(process.env, env);
	try {
		piProfile(api as never);
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { hasUI: false, sessionManager: { getBranch: () => branch } });
	} finally {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	}
	return appended;
}

describe("session tagging", () => {
	it("tags an untagged session with the current profile and host", () => {
		assert.deepEqual(tagToAppend([{ type: "message" }], here), here);
	});

	it("does not tag a session twice", () => {
		assert.equal(tagToAppend([tagEntry("work", "box"), { type: "message" }], here), undefined);
	});

	it("tags again when a session moves to another host or profile", () => {
		assert.deepEqual(tagToAppend([tagEntry("work", "laptop")], here), here);
		assert.deepEqual(tagToAppend([tagEntry("home", "box")], here), here);
		assert.equal(tagToAppend([tagEntry("work", "laptop"), tagEntry("work", "box")], here), undefined);
	});

	it("ignores other custom entries and malformed tags", () => {
		const entries: EntryLike[] = [
			tagEntry("work", "box"),
			{ type: "custom", customType: "other/thing", data: { profile: "x", hostId: "y" } },
			{ type: "custom", customType: TAG_TYPE, data: { profile: 1 } },
			{ type: "message", customType: TAG_TYPE, data: { profile: "x", hostId: "y" } },
		];
		assert.deepEqual(lastTag(entries), here);
		assert.equal(lastTag([]), undefined);
	});

	it("takes the host from config.json and the profile from the environment", () => {
		writeConfig("cfg-host");
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
		assert.deepEqual(tagFor(env, () => assert.fail("must not look up the host")), { profile: "default", hostId: "cfg-host" });
	});

	it("looks up the host when config.json has none", () => {
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" };
		assert.deepEqual(tagFor(env, () => "looked-up"), { profile: "default", hostId: "looked-up" });
	});

	it("appends one pi-profile/tag entry from the extension at session start", () => {
		createProfile(s.l, "work");
		writeConfig("box");
		const env = { PI_PROFILE_HOME: s.home, PI_PROFILE_LABEL: "work", PI_CODING_AGENT_DIR: join(s.home, "profiles", "work"), PI_PROFILE_HOST_ID: "ignored" };
		assert.deepEqual(start(env, []), [[TAG_TYPE, { profile: "work", hostId: "box" }]]);
		assert.deepEqual(start(env, [tagEntry("work", "box")]), []);
	});

	it("starts the session without a tag when config.json is broken", () => {
		mkdirSync(join(s.home, "pi-profile"), { recursive: true });
		writeFileSync(join(s.home, "pi-profile", "config.json"), "{ not json");
		assert.deepEqual(start({ PI_PROFILE_HOME: s.home, PI_PROFILE_NO_GLOBAL_DEFAULT: "1" }, []), []);
	});
});
