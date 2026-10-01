#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { INTENT_DIR, cli, json, lawIds, read, reject, rootArg, run, unavailable, verifyHeaders } from './intent-core.mjs';

const lines = text => text.split(/\r?\n/).filter(line => line.trim() !== '').sort();
export async function conform(root, requireCoverage = false) {
  verifyHeaders(import.meta.url);
  const laws = lawIds(read(join(root, INTENT_DIR, 'model', 'LAWS.bend')));
  const manifest = json(join(root, INTENT_DIR, 'conform.json'));
  if (manifest?.schema !== 1 || !Array.isArray(manifest.checks) || !manifest.checks.length) unavailable(`${INTENT_DIR}/conform.json requires schema: 1 and a nonempty checks[]; write a manifest`);
  const covered = new Set();
  const names = new Set();
  // Validate the entire manifest before executing any command.
  const checks = manifest.checks.map(c => {
    if (!c || typeof c.name !== 'string' || !c.name.trim() || names.has(c.name) || !Array.isArray(c.laws) || !c.laws.length || c.laws.some(l => typeof l !== 'string')) unavailable('conform.json: each check needs a unique name and laws[]; fix the manifest');
    names.add(c.name);
    for (const law of c.laws) {
      if (!laws.includes(law)) reject(`${c.name}: law ${law} is not declared in LAWS.bend; correct laws[] or approve the new law`);
      covered.add(law);
    }
    for (const key of ['model', 'real', 'broken']) if (!Array.isArray(c[key]) || !c[key].length || c[key].some((a, i) => typeof a !== 'string' || (i === 0 && !a) || a.includes('\0'))) unavailable(`${c.name}: ${key} must be an argv array; fix conform.json`);
    const timeoutMs = c.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || (c.cwd !== undefined && typeof c.cwd !== 'string')) unavailable(`${c.name}: invalid cwd or timeoutMs (1..600000); fix conform.json`);
    // Copy only named fields; never pass arbitrary manifest options into execFile.
    return { name: c.name, model: [...c.model], real: [...c.real], broken: [...c.broken], cwd: resolve(root, c.cwd ?? '.'), timeoutMs };
  });
  for (const check of checks) {
    const outputs = {};
    for (const key of ['model', 'real', 'broken']) {
      const result = await run(check[key], check.cwd, check.timeoutMs);
      if (result.status !== 0) reject(`${check.name}: ${key} exited ${result.status}; fix the oracle command:\n${result.stderr}`);
      outputs[key] = lines(result.stdout);
      if (!outputs[key].length) reject(`${check.name}: ${key} emitted no cases; enumerate the finite domain`);
    }
    if (JSON.stringify(outputs.model) !== JSON.stringify(outputs.real)) {
      const counts = rows => rows.reduce((m, row) => m.set(row, (m.get(row) ?? 0) + 1), new Map());
      const model = counts(outputs.model), real = counts(outputs.real);
      const disagreement = [...new Set([...model.keys(), ...real.keys()])].filter(row => model.get(row) !== real.get(row)).map(row => `${row} (model=${model.get(row) ?? 0}, real=${real.get(row) ?? 0})`);
      reject(`${check.name}: conformance drift; fix the real code or approve changed laws:\n${disagreement.join('\n')}`);
    }
    if (JSON.stringify(outputs.broken) === JSON.stringify(outputs.real)) reject(`${check.name}: oracle does not exercise the real code; call the app's implementation and use a genuinely broken model`);
    console.log(`pass ${check.name}: ${outputs.real.length} cases; broken model differs`);
  }
  const uncovered = laws.filter(law => !covered.has(law));
  console.log(`uncovered laws: ${uncovered.join(', ') || 'none'}`);
  if (requireCoverage && uncovered.length) reject('conformance coverage incomplete; add checks for the uncovered laws');
}
await cli(argv => conform(rootArg(argv, ['--require-coverage']), argv.includes('--require-coverage')), import.meta.url);
