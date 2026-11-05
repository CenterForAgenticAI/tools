import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

// pi.extensions names the bundle itself. A .ts wrapper that only re-exports the
// compiled bundle does not move the bundle's imports onto the host Pi (issue #285).
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

test("pi.extensions names the bundle, and no .ts wrapper ships", () => {
	assert.deepEqual(manifest.pi.extensions, ["./dist/extension.js"]);
	assert.ok(!manifest.files.includes("pi-extension.ts"));
	assert.ok(!existsSync(path.join(PACKAGE_ROOT, "pi-extension.ts")));
});

test("Pi's loader resolves the package entry to the bundle", async (t) => {
	try {
		readFileSync(path.join(PACKAGE_ROOT, "dist", "extension.js"));
	} catch {
		t.skip("dist/extension.js is not built");
		return;
	}
	const loader = new DefaultResourceLoader({
		cwd: PACKAGE_ROOT,
		agentDir: path.join(PACKAGE_ROOT, ".test-dist", "host-pi-loading-agent"),
		additionalExtensionPaths: [PACKAGE_ROOT],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.extensions.map((extension) => extension.resolvedPath), [path.join(PACKAGE_ROOT, "dist", "extension.js")]);
});
