import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ansiFg, isColor, PALETTE, resolveColor, stableColor } from "../src/core/color.ts";
import { validateEnv } from "../src/core/env.ts";
import { parseManifest, serializeManifest } from "../src/core/manifest.ts";
import { isProfileName, isSelectableName } from "../src/core/names.ts";
import { selectSource } from "../src/core/select.ts";
import { fail, ok } from "../src/core/result.ts";
import { stamp } from "../src/core/fsutil.ts";

describe("selectSource (laws L1-L3)", () => {
	it("an explicit choice beats everything", () => {
		assert.equal(selectSource({ explicit: "a", exportedDir: "/x", globalDefault: "g", noGlobalDefault: false }), "explicit");
	});
	it("an exported dir beats the global default", () => {
		assert.equal(selectSource({ exportedDir: "/x", globalDefault: "g", noGlobalDefault: false }), "exported");
	});
	it("the opt-out ignores the global default", () => {
		assert.equal(selectSource({ globalDefault: "g", noGlobalDefault: true }), "builtin-default");
	});
	it("falls back to the global default, then the built-in one", () => {
		assert.equal(selectSource({ globalDefault: "g", noGlobalDefault: false }), "global-default");
		assert.equal(selectSource({ noGlobalDefault: false }), "builtin-default");
	});
});

describe("names", () => {
	it("accepts one safe path component", () => {
		assert.equal(isProfileName("fabric-lite"), true);
		assert.equal(isProfileName("a.b_c"), true);
	});
	it("refuses traversal, separators, hidden names and the reserved name", () => {
		for (const bad of ["..", "../x", "a/b", ".hidden", "", "default", "a b", "x".repeat(65)]) assert.equal(isProfileName(bad), false, bad);
		assert.equal(isSelectableName("default"), true);
		assert.equal(isSelectableName("../x"), false);
	});
});

describe("color", () => {
	it("accepts hex and palette names only", () => {
		assert.equal(isColor("#A1b2C3"), true);
		assert.equal(isColor("teal"), true);
		assert.equal(isColor("toString"), false);
		assert.equal(isColor("#abc"), false);
	});
	it("resolves names and hex, and is stable per name when unset", () => {
		assert.equal(resolveColor("x", "teal"), PALETTE["teal"]);
		assert.equal(resolveColor("x", "#ABCDEF"), "#abcdef");
		assert.equal(resolveColor("fabric", undefined), stableColor("fabric"));
		assert.equal(stableColor("fabric"), stableColor("fabric"));
		assert.ok(Object.values(PALETTE).includes(stableColor("anything")));
	});
	it("renders a 24-bit escape", () => {
		assert.equal(ansiFg("#0a0b0c", "x"), "\u001b[38;2;10;11;12mx\u001b[39m");
	});
});

describe("env allow-list", () => {
	const dir = "/home/user/.pi/profiles/p";
	it("keeps allowed values", () => {
		const r = validateEnv({ ACP_AUTO_UPDATE: "0", PI_MEMORY_DIR: `${dir}/memory` }, dir);
		assert.deepEqual(r, ok({ ACP_AUTO_UPDATE: "0", PI_MEMORY_DIR: `${dir}/memory` }));
	});
	it("refuses variables outside the allow-list, e.g. PATH or LD_PRELOAD", () => {
		const r = validateEnv({ LD_PRELOAD: "/tmp/evil.so", PATH: "/tmp" }, dir);
		assert.equal(r.ok, false);
	});
	it("refuses path values outside the profile, relative or traversing", () => {
		for (const v of ["/etc/passwd", "memory", `${dir}/../other/memory`, dir]) {
			assert.equal(validateEnv({ PI_MEMORY_DIR: v }, dir).ok, false, v);
		}
	});
	it("refuses control characters and non-strings", () => {
		assert.equal(validateEnv({ ACP_DELEGATE: "a\nexport X=1" }, dir).ok, false);
		assert.equal(validateEnv({ ACP_DELEGATE: 1 }, dir).ok, false);
		assert.equal(validateEnv([], dir).ok, false);
	});
});

describe("manifest", () => {
	const dir = "/p";
	it("round-trips a full manifest", () => {
		const m = {
			schemaVersion: 1,
			name: "x",
			description: "d",
			color: "teal",
			auth: { mode: "pooled" },
			multiAccount: { group: "caair", members: ["a"] },
			sessions: { store: "profile" },
			env: { ACP_AUTO_UPDATE: "0" },
		};
		const r = parseManifest(m, dir);
		assert.ok(r.ok);
		assert.deepEqual(JSON.parse(serializeManifest(r.value)), m);
	});
	it("defaults auth to shared", () => {
		const r = parseManifest({ schemaVersion: 1, name: "x" }, dir);
		assert.ok(r.ok);
		assert.equal(r.value.auth.mode, "shared");
	});
	it("refuses unknown keys, so secrets cannot be smuggled in (L8)", () => {
		const r = parseManifest({ schemaVersion: 1, name: "x", apiKey: "sk-..." }, dir);
		assert.equal(r.ok, false);
		assert.ok(!r.ok && r.errors.some((e) => e.includes("apiKey")));
	});
	it("reports every bad field", () => {
		const r = parseManifest(
			{
				schemaVersion: 2,
				name: "",
				description: 5,
				color: "mauve",
				auth: { mode: "shared", key: "x" },
				multiAccount: { group: "../x" },
				sessions: { store: "" },
				env: { PATH: "/x" },
			},
			dir,
		);
		assert.ok(!r.ok);
		assert.equal(r.errors.length, 8);
	});
	it("checks multi-account members", () => {
		assert.equal(parseManifest({ schemaVersion: 1, name: "x", multiAccount: { group: "g", members: [1] } }, dir).ok, false);
		assert.equal(parseManifest({ schemaVersion: 1, name: "x", multiAccount: { group: "g", extra: 1 } }, dir).ok, false);
		assert.equal(parseManifest("x", dir).ok, false);
	});
});

describe("small helpers", () => {
	it("result and stamp", () => {
		assert.deepEqual(fail("a", "b"), { ok: false, errors: ["a", "b"] });
		assert.match(stamp(new Date("2026-01-02T03:04:05.678Z")), /^20260102-030405/);
	});
});
