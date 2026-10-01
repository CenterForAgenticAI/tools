#!/usr/bin/env node
import { join, relative } from 'node:path';
import { check } from './intent-check.mjs';
import { bendFiles, cli, codeOnly, hasProof, lawIds, read, reject, rootArg, run } from './intent-core.mjs';

export async function gate(root, bend = process.env.BEND_BIN || 'bend') {
  console.log(check(root));
  const dir = join(root, 'intent', 'model');
  const files = bendFiles(dir);
  const negatives = files.filter(f => relative(dir, f).startsWith('neg/') || /(^|\/)neg-[^/]*\.bend$/.test(relative(dir, f)));
  if (!negatives.length) reject('intent/model/neg is empty; add a negative control for each law');
  const proofFile = join(dir, 'PROOF.bend');
  const proof = read(proofFile);
  const entries = new Set([proofFile]);
  for (const file of files) {
    const text = codeOnly(read(file));
    if (/@unsafe\b|^\s*def\s+[\w.]+\?\s*\(|\?TODO\b/m.test(text)) reject(`${relative(dir, file)}: forbidden @unsafe, def f? or ?TODO; write a total proof`);
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
await cli(argv => gate(rootArg(argv)), import.meta.url);
