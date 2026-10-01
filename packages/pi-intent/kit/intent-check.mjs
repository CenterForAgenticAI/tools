#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INTENT_DIR, cli, read, json, sha256, record, lawIds, reject, unavailable, verifyReceipt, verifyHeaders, rootArg, isDirectory } from './intent-core.mjs';

export function check(root, scriptUrl = import.meta.url) {
  verifyHeaders(scriptUrl);
  const dir = join(root, INTENT_DIR);
  if (!isDirectory(join(dir, 'records'))) unavailable(`${INTENT_DIR}/records unavailable; run pi-intent init`);
  const names = readdirSync(join(dir, 'records')).filter(n => n.endsWith('.md')).sort();
  if (!names.length) reject(`${INTENT_DIR}/records is empty; draft and approve an intent record`);
  const laws = read(join(dir, 'model', 'LAWS.bend'));
  lawIds(laws);
  const hash = read(join(dir, 'model', 'laws.sha256')).trim();
  if (hash !== sha256(laws)) reject(`LAWS.bend changed since approval; obtain human approval and write ${sha256(laws)} to ${INTENT_DIR}/model/laws.sha256, then regenerate receipts`);
  let approved = 0;
  for (const name of names) {
    const path = join(dir, 'records', name);
    const text = read(path);
    const rec = record(text, name);
    if (rec.status !== 'approved') continue;
    approved++;
    verifyReceipt(json(join(dir, 'receipts', `${rec.id}.json`)), rec, laws, text);
  }
  if (!approved) reject('no approved intent record; request human approval then run intent-receipt');
  return `intent-check: ok (${approved} approved record(s))`;
}
await cli(argv => console.log(check(rootArg(argv))), import.meta.url);
