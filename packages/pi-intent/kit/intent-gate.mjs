#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { check } from './intent-check.mjs';
import { explain } from './intent-impact.mjs';
import { FORBIDDEN_BEND, INTENT_DIR, bendFiles, cli, codeOnly, hasProof, lawIds, read, reject, rootArg, run, unavailable } from './intent-core.mjs';

// Bend is the ground truth for which laws exist; the offline scanner (lawIds) must agree with it. Bend 2.0.35 reports every law that has no
// proof def as an open claim: `Error: N TODOs found` for a file importing LAWS.bend with no proofs, and a def named `M.<id>` with a wrong
// body fails at `Location: M.<id>` when law <id> exists but as `expected : a fresh name` when it does not. Both outputs were read from the
// bend binary (see tests/unit/kit.test.mjs); a different Bend that words them differently is refused as unrecognised output, never passed.
// Checks the set of law ids (count and names); the order of declarations is the scanner's and cannot be read from Bend.
export async function crossCheckLaws(dir, bend, ids, runBend = run) {
  const probe = join(dir, `.crosscheck-${process.pid}-${randomBytes(4).toString('hex')}.bend`);
  const ask = async (body, imports = ['./LAWS.bend']) => {
    const header = imports.map((file, i) => `import ${file} as ${i === 0 && file === './LAWS.bend' ? 'M' : `H${i}`}\n`).join('');
    try { writeFileSync(probe, `import Base\n${header}${body}`); }
    catch (error) { unavailable(`cannot write the Bend cross-check probe ${probe}: ${error.message}; the model directory must be writable for intent-gate`); }
    const result = await runBend([bend, probe, '--check-only'], dir, 60_000);
    return result.stdout + result.stderr;
  };
  const onInterrupt = () => { rmSync(probe, { force: true }); process.off('SIGINT', onInterrupt); process.kill(process.pid, 'SIGINT'); };
  process.once('SIGINT', onInterrupt);
  try {
    // Bend counts open laws through the whole import graph, but the scanner reads LAWS.bend only. Laws opened in a file LAWS.bend imports
    // (proven in PROOF.bend) are not LAWS.bend declarations: measure them with a probe that imports those files without LAWS.bend.
    const lawsCode = codeOnly(read(join(dir, 'LAWS.bend')), 'LAWS.bend');
    const imports = [...lawsCode.matchAll(/^import\s+(\S+)\s+as\s+(\w+)\s*$/gm)].filter(m => m[1] !== 'Base');
    if (imports.some(m => !/^\.{1,2}\/[\w./-]+\.bend$/.test(m[1]))) reject('LAWS.bend: imports must be relative .bend paths (./X.bend or ../X.bend) so the gate can cross-check them');
    // A LAWS.bend def under an import alias would close a helper law outside PROOF.bend and hide it from the open-law count.
    const aliases = imports.map(m => m[2]);
    if (aliases.some(alias => new RegExp(`^def\\s+${alias}\\.`, 'm').test(lawsCode))) reject('LAWS.bend: do not define names under an import alias; prove helper laws in PROOF.bend');
    const imported = [...new Set(imports.map(m => m[1]))];
    let helper = 0;
    if (imported.length) {
      const out = await ask('', imported);
      const found = /^Error: (\d+) TODOs? found\.?\r?$/m.exec(out);
      helper = found ? Number(found[1]) : /^ALL PROOFS CHECK\r?$/m.test(out) ? 0 : null;
      if (helper === null) reject(`LAWS.bend: Bend gave output the cross-check does not recognise for the files LAWS.bend imports:\n${out.slice(0, 500)}`);
    }
    const output = await ask('');
    const count = /^Error: (\d+) TODOs? found\.?\r?$/m.exec(output);
    const total = count ? Number(count[1]) : /^ALL PROOFS CHECK\r?$/m.test(output) ? 0 : null;
    if (total === null) reject(`LAWS.bend: Bend gave output the cross-check does not recognise; the gate cannot confirm the law list:\n${output.slice(0, 500)}`);
    const seen = total - helper;
    if (seen !== ids.length) reject(`LAWS.bend: Bend sees ${seen} laws but the offline scanner found ${ids.length}; a law is hidden from the scanner or invented by it. Keep each declaration at column zero in plain layout`);
    for (const id of ids) {
      const out = await ask(`\ndef M.${id}():\n  7n\n`);
      if (new RegExp(`^Location: M\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`, 'm').test(out)) continue;
      if (/expected : a fresh name/.test(out)) reject(`LAWS.bend: the scanner lists law ${id} but Bend sees no law of that name`);
      reject(`LAWS.bend: Bend gave output the cross-check does not recognise for law ${id}:\n${out.slice(0, 500)}`);
    }
  } finally { process.off('SIGINT', onInterrupt); rmSync(probe, { force: true }); }
}

export async function gate(root, bend = process.env.BEND_BIN || 'bend') {
  console.log(check(root));
  const dir = join(root, INTENT_DIR, 'model');
  const files = bendFiles(dir);
  const negatives = files.filter(f => relative(dir, f).startsWith('neg/') || /(^|\/)neg-[^/]*\.bend$/.test(relative(dir, f)));
  if (!negatives.length) reject(`${INTENT_DIR}/model/neg is empty; add a negative control for each law`);
  const proofFile = join(dir, 'PROOF.bend');
  const proof = read(proofFile);
  const entries = new Set([proofFile]);
  for (const file of files) {
    const text = codeOnly(read(file), file);
    if (FORBIDDEN_BEND.test(text)) reject(`${relative(dir, file)}: forbidden @unsafe, def f? or ?TODO; write a total proof`);
    if (negatives.includes(file)) continue;
    for (const match of text.matchAll(/^law\s+([\w.]+)\s*:/gm)) {
      const inEntry = hasProof(file, match[1], proofFile, proof);
      const local = file !== join(dir, 'LAWS.bend') && hasProof(file, match[1], file, text);
      if (!inEntry && !local) reject(`${relative(dir, file)}: law ${match[1]} has no proof def resolving to its declaration; add it to PROOF.bend`);
      if (local) entries.add(file); // An unimported helper's proof body must also check.
    }
  }
  for (const entry of entries) {
    const positive = await run([bend, entry, '--check-only'], dir, 600_000);
    const output = positive.stdout + positive.stderr;
    if (positive.status !== 0 || !/^(?:All terms check\.|ALL PROOFS CHECK)\r?$/m.test(output) || /^SOME PROOFS FAIL\r?$/m.test(output)) reject(`${relative(dir, entry)} did not check; fix the proof:\n${output}`);
  }
  const controlled = new Set();
  const laws = lawIds(read(join(dir, 'LAWS.bend')));
  await crossCheckLaws(dir, bend, laws);
  for (const file of negatives) {
    const marker = /^#\s*expect-failure:\s*(.+?)\s*$/m.exec(read(file))?.[1];
    if (!marker) reject(`${relative(dir, file)}: missing # expect-failure: <law>; name the expected failing judgment`);
    const law = laws.find(l => marker === l || marker.endsWith(`.${l}`));
    if (!law || !hasProof(join(dir, 'LAWS.bend'), law, file, read(file))) reject(`${relative(dir, file)}: control names an unrelated law; target a declared LAWS.bend law`);
    controlled.add(law);
    const result = await run([bend, file, '--check-only'], dir, 600_000);
    const text = result.stdout + result.stderr;
    // A syntax failure is not a negative judgment. Require the failed proof verdict.
    if (!/^SOME PROOFS FAIL\r?$/m.test(text) || !text.split(/\r?\n/).includes(`Location: ${marker}`)) reject(`${relative(dir, file)}: control did not fail at ${marker}; repair the control (syntax/tool errors do not count):\n${text}`);
  }
  const missing = laws.filter(l => !controlled.has(l));
  if (missing.length) reject(`laws lack negative controls: ${missing.join(', ')}; add neg/*.bend for each law`);
  console.log(`intent-gate: ok (${negatives.length} negative controls)`);
}
await cli(async argv => {
  const root = rootArg(argv);
  try { await gate(root); } catch (error) { throw await explain(root, error); }
}, import.meta.url);
