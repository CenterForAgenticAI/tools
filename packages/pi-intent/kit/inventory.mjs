#!/usr/bin/env node
// Declaration inventory for a Bend model.
//
// Usage: node inventory.mjs <model-dir> > inventory.json
//
// Lists every authored declaration in the model's non-negative .bend files:
// types, constructors (with fields), defs, and laws. Each law is marked
// "defined" when a def resolves to its law's file, else "open". Only the gate
// can establish that the judgment is proven.
// Each entry carries its file, line, and the file's SHA-256, so a plain-
// language description (a "blind translation") can cite exact sources and a
// validator can check that every declaration is covered exactly once.
//
// This is a syntactic inventory: it does not run bend. Run gate.mjs for the
// proof check. Exit 2 when the directory is missing.
import { bendFiles, cli, hasProof, read, unavailable, verifyHeaders } from './intent-core.mjs';
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function isNegative(rel) {
	return /(^|\/)neg-[^/]*\.bend$/.test(rel) || /^neg\//.test(rel);
}

const TYPE = /^type\s+([A-Za-z_][\w.]*)/;
const DEF = /^(@unsafe\s+)?def\s+([A-Za-z_][\w.]*\??)\s*\(/;
const LAW = /^law\s+([A-Za-z_][\w.]*)\s*:/;
const CTOR = /^\s+([A-Z][\w]*)\{([^}]*)\}\s*$/;

export function inventory(dir) {
	const root = resolve(dir);
	const files = [];
	const declarations = [];
	for (const path of bendFiles(root)) {
		const rel = relative(root, path);
		if (isNegative(rel)) continue;
		const bytes = readFileSync(path);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		files.push({ file: rel, sha256 });
		const lines = bytes.toString("utf8").split("\n");
		let currentType;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const at = { file: rel, line: i + 1 };
			let m;
			if ((m = TYPE.exec(line))) {
				currentType = m[1];
				declarations.push({ id: m[1], kind: "type", ...at });
				continue;
			}
			if (currentType && (m = CTOR.exec(line))) {
				const fields = m[2]
					.split(",")
					.map((f) => f.trim())
					.filter(Boolean)
					.map((f) => {
						const [name, ...type] = f.split(":");
						return { name: name.trim(), type: type.join(":").trim() };
					});
				declarations.push({ id: `${currentType}.${m[1]}`, kind: "constructor", type: currentType, fields, ...at });
				continue;
			}
			if (line.trim() !== "" && !/^\s/.test(line)) currentType = undefined;
			if ((m = LAW.exec(line))) declarations.push({ id: m[1], kind: "law", ...at });
			else if ((m = DEF.exec(line))) declarations.push({ id: m[2], kind: "def", unsafe: Boolean(m[1]) || m[2].endsWith("?"), ...at });
		}
	}
	const proofDefs = new Set();
	for (const law of declarations.filter((d) => d.kind === "law")) {
		law.status = "open";
		for (const def of declarations.filter((d) => d.kind === "def")) {
			if ((def.id === law.id || def.id.endsWith(`.${law.id}`)) && hasProof(join(root, law.file), law.id, join(root, def.file), read(join(root, def.file)))) {
				law.status = "defined";
				proofDefs.add(def);
			}
		}
	}
	for (const d of proofDefs) d.kind = "proof";
	const counts = { type: 0, constructor: 0, def: 0, law: 0, proof: 0 };
	for (const d of declarations) counts[d.kind] += 1;
	counts.openLaws = declarations.filter((d) => d.kind === "law" && d.status === "open").length;
	return { tool: "compiled-intent/bend/inventory.mjs", files, counts, declarations };
}

await cli(argv => {
	verifyHeaders(import.meta.url);
	const dir = argv[0];
	if (argv.length !== 1 || !existsSync(dir) || !statSync(dir).isDirectory()) unavailable('inventory: usage: inventory.mjs <model-dir>; restore the directory');
	process.stdout.write(`${JSON.stringify(inventory(dir), null, 2)}\n`);
}, import.meta.url);
