import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	expectedSdkVersions,
	validateInstalledSdkGraph,
	validateLockfileSdkGraph,
} from "../scripts/check-sdk-graph.mjs";

const PI_AI = "@earendil-works/pi-ai";
const PI_CODING_AGENT = "@earendil-works/pi-coding-agent";
const PI_AGENT_CORE = "@earendil-works/pi-agent-core";

function manifestFixture() {
	return {
		devDependencies: { [PI_AI]: "1.4.0", [PI_CODING_AGENT]: "1.4.0", typebox: "1.3.35" },
		overrides: {
			[PI_AGENT_CORE]: `$${PI_CODING_AGENT}`,
			[PI_AI]: `$${PI_AI}`,
			[PI_CODING_AGENT]: `$${PI_CODING_AGENT}`,
		},
	};
}

function lockfileFixture() {
	return {
		packages: {
			"": {},
			[`node_modules/${PI_AGENT_CORE}`]: { version: "1.4.0" },
			[`node_modules/${PI_AI}`]: { version: "1.4.0" },
			[`node_modules/${PI_CODING_AGENT}`]: { version: "1.4.0" },
			["node_modules/typebox"]: { version: "1.3.35" },
			[`node_modules/${PI_AI}/node_modules/typebox`]: { version: "1.3.27" },
		},
	};
}

function writePackage(root, location, version) {
	fs.mkdirSync(path.join(root, location), { recursive: true });
	fs.writeFileSync(path.join(root, location, "package.json"), JSON.stringify({ version }));
}

function installedFixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-graph-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const name of [PI_AGENT_CORE, PI_AI, PI_CODING_AGENT]) writePackage(root, `node_modules/${name}`, "1.4.0");
	writePackage(root, "node_modules/typebox", "1.3.35");
	writePackage(root, `node_modules/${PI_AI}/node_modules/typebox`, "1.3.27");
	return root;
}

test("overrides resolve through development pins, so the whole SDK follows them", () => {
	const manifest = manifestFixture();
	manifest.devDependencies[PI_AI] = "1.4.1";
	manifest.devDependencies[PI_CODING_AGENT] = "1.4.1";
	const { expected, errors } = expectedSdkVersions(manifest);
	assert.deepEqual(errors, []);
	assert.deepEqual(Object.fromEntries(expected), { [PI_AGENT_CORE]: "1.4.1", [PI_AI]: "1.4.1", [PI_CODING_AGENT]: "1.4.1" });
});

test("rejects overrides that would not follow the development pin", async (t) => {
	await t.test("a literal version", () => {
		const manifest = manifestFixture();
		manifest.overrides[PI_AGENT_CORE] = "1.4.0";
		assert.match(expectedSdkVersions(manifest).errors.join("\n"), /pi-agent-core override must reference a development pin with "\$"/);
	});

	await t.test("a development dependency without an override", () => {
		const manifest = manifestFixture();
		delete manifest.overrides[PI_AI];
		assert.match(expectedSdkVersions(manifest).errors.join("\n"), /pi-ai is a development dependency without an override/);
	});

	await t.test("a development dependency pointed at another pin", () => {
		const manifest = manifestFixture();
		manifest.overrides[PI_AI] = `$${PI_CODING_AGENT}`;
		assert.match(expectedSdkVersions(manifest).errors.join("\n"), /its override must be "\$@earendil-works\/pi-ai"/);
	});

	await t.test("a reference to a range rather than an exact pin", () => {
		const manifest = manifestFixture();
		manifest.devDependencies[PI_CODING_AGENT] = "^1.4.0";
		assert.match(expectedSdkVersions(manifest).errors.join("\n"), /references @earendil-works\/pi-coding-agent, which is not an exact development pin/);
	});
});

test("accepts a lockfile with one top-level copy of each SDK package at the pinned version", () => {
	assert.deepEqual(validateLockfileSdkGraph(manifestFixture(), lockfileFixture()), []);
});

test("rejects lockfile SDK drift from the overrides", async (t) => {
	await t.test("a nested duplicate pi-ai, the TS2322 private 'queue' failure", () => {
		const lockfile = lockfileFixture();
		lockfile.packages[`node_modules/${PI_AGENT_CORE}/node_modules/${PI_AI}`] = { version: "1.4.1" };
		assert.match(
			validateLockfileSdkGraph(manifestFixture(), lockfile).join("\n"),
			/nested SDK copy at node_modules\/@earendil-works\/pi-agent-core\/node_modules\/@earendil-works\/pi-ai \(1\.4\.1\)/,
		);
	});

	await t.test("a top-level version that differs from the pin", () => {
		const lockfile = lockfileFixture();
		lockfile.packages[`node_modules/${PI_AGENT_CORE}`].version = "1.4.1";
		assert.match(validateLockfileSdkGraph(manifestFixture(), lockfile).join("\n"), /resolves @earendil-works\/pi-agent-core@1\.4\.1; the overrides pin 1\.4\.0/);
	});

	await t.test("an SDK package with no override", () => {
		const lockfile = lockfileFixture();
		lockfile.packages["node_modules/@earendil-works/pi-tui"] = { version: "1.4.1" };
		assert.match(validateLockfileSdkGraph(manifestFixture(), lockfile).join("\n"), /contains @earendil-works\/pi-tui@1\.4\.1 without an override/);
	});

	await t.test("a development pin the lockfile no longer has", () => {
		const lockfile = lockfileFixture();
		delete lockfile.packages[`node_modules/${PI_AI}`];
		assert.match(validateLockfileSdkGraph(manifestFixture(), lockfile).join("\n"), /has no top-level @earendil-works\/pi-ai/);
	});
});

test("accepts an override for a package this SDK release does not install", () => {
	const lockfile = lockfileFixture();
	delete lockfile.packages[`node_modules/${PI_AGENT_CORE}`];
	assert.deepEqual(validateLockfileSdkGraph(manifestFixture(), lockfile), []);
});

test("accepts an installed tree with one top-level copy of each SDK package", (t) => {
	assert.deepEqual(validateInstalledSdkGraph(manifestFixture(), installedFixture(t)), []);
});

test("rejects installed SDK drift from the overrides", async (t) => {
	await t.test("a nested duplicate pi-ai", (st) => {
		const root = installedFixture(st);
		writePackage(root, `node_modules/${PI_AGENT_CORE}/node_modules/${PI_AI}`, "1.4.1");
		assert.match(
			validateInstalledSdkGraph(manifestFixture(), root).join("\n"),
			/nested SDK copy at node_modules\/@earendil-works\/pi-agent-core\/node_modules\/@earendil-works\/pi-ai \(1\.4\.1\)/,
		);
	});

	await t.test("a newer top-level patch", (st) => {
		const root = installedFixture(st);
		writePackage(root, `node_modules/${PI_AGENT_CORE}`, "1.4.1");
		assert.match(validateInstalledSdkGraph(manifestFixture(), root).join("\n"), /resolves @earendil-works\/pi-agent-core@1\.4\.1; the overrides pin 1\.4\.0/);
	});

	await t.test("no installed tree", (st) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-graph-empty-"));
		st.after(() => fs.rmSync(root, { recursive: true, force: true }));
		assert.match(validateInstalledSdkGraph(manifestFixture(), root).join("\n"), /node_modules is missing/);
	});
});
