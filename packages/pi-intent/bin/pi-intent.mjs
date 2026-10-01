#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTENT_DIR, cli, json, read, sha256, unavailable } from '../kit/intent-core.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function vendor(root) {
  const version = json(join(packageRoot, 'package.json')).version;
  mkdirSync(join(root, INTENT_DIR, 'tools'), { recursive: true });
  for (const name of readdirSync(join(packageRoot, 'kit')).filter(n => n.endsWith('.mjs'))) {
    const body = read(join(packageRoot, 'kit', name));
    const lines = body.split('\n');
    const index = lines[0].startsWith('#!') ? 1 : 0;
    lines.splice(index, 0, `// pi-intent v${version} sha256=${sha256(body)}`);
    writeFileSync(join(root, INTENT_DIR, 'tools', name), lines.join('\n'), { mode: 0o755 });
  }
  console.log(`pi-intent: vendored v${version}; review and commit ${INTENT_DIR}/tools/ (local changes overwritten)`);
}
export function init(root) {
  if (existsSync(join(root, INTENT_DIR))) unavailable(`${INTENT_DIR}/ already exists; preserve it and use pi-intent vendor to update tools only`);
  mkdirSync(root, { recursive: true });
  cpSync(join(packageRoot, 'templates'), join(root, INTENT_DIR), { recursive: true });
  cpSync(join(packageRoot, 'kit', 'Lib.bend'), join(root, INTENT_DIR, 'model', 'Lib.bend'));
  vendor(root);
  console.log(`pi-intent: scaffolded ${INTENT_DIR}/; draft the record, define laws and proofs, then request human approval (init does not approve)`);
}
await cli(argv => {
  if (argv.length !== 2 || !['vendor', 'init'].includes(argv[0])) unavailable('usage: pi-intent vendor <dir> | init <dir>');
  const root = resolve(argv[1]);
  if (argv[0] === 'vendor') vendor(root); else init(root);
}, import.meta.url);
