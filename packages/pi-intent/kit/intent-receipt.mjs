#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { POLICY, canonical, cli, coverageQuestions, fidelityQuestions, lawIds, read, record, reject, seal, sha256, unavailable, verdict, verifyHeaders } from './intent-core.mjs';

// Evaluator contract: (JevRequest) => Promise<JevResponse>. Tests inject a fake.
export async function produce(recordText, lawsText, filename, model, evaluate) {
  const rec = record(recordText, filename);
  if (rec.status !== 'approved') reject('record is not approved; request human approval before intent-receipt');
  if (typeof model !== 'string' || !model.trim()) unavailable('Jev model is required; pass a model id to intent-receipt');
  const laws = lawIds(lawsText);
  const coverage = coverageQuestions(rec.clauses, laws);
  const state = { record: recordText, laws: lawsText };
  const first = await evaluate({ state, questions: coverage, model });
  const snapshot = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9]{8}$`);
  if (typeof first.model !== 'string' || (first.model !== model && !snapshot.test(first.model))) reject('Jev returned a different model; select one explicit model and regenerate');
  const fidelity = fidelityQuestions(rec.clauses, laws, first.answers ?? {});
  const second = await evaluate({ state, questions: fidelity, model });
  if (second.model !== first.model) reject('Jev returned a different model; select one explicit model and regenerate');
  // Validate raw judgments, then copy only named typed fields. Model output must
  // not inject a verdict, arbitrary metadata or subprocess options into storage.
  const computed = verdict(rec.clauses, laws, first.answers, second.answers);
  const answers = {
    coverage: Object.fromEntries(rec.clauses.map(c => { const a = first.answers[c.id]; return [c.id, { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries([...laws, 'none'].map(l => [l, a.probabilities[l]])) }]; })),
    fidelity: Object.fromEntries(laws.map(l => [l, { type: 'noul', noul: second.answers[l].noul }])),
  };
  return seal({ schema: 1, recordId: rec.id, recordSha256: sha256(recordText), lawsSha256: sha256(lawsText), policy: POLICY, model: first.model, questions: { coverage, fidelity }, answers, verdict: computed });
}
export async function liveEvaluator(model, loadFabric = () => import('pi-fabric/jev')) {
  let fabric;
  try { fabric = await loadFabric(); }
  catch { unavailable('pi-fabric/jev unavailable; install pi-fabric beside the authoring project (npm install --no-save pi-fabric), configure Jev credentials, then rerun intent-receipt; CI needs neither'); }
  const target = fabric.resolveJevModelRoute(model);
  const client = new fabric.JevClient(fabric.normalizeJevConfig({ enabled: true, model }), fetch, undefined, target.route);
  return { evaluate: request => client.evaluate(request, AbortSignal.timeout(60_000)), close: () => client.close() };
}
await cli(async argv => {
  verifyHeaders(import.meta.url);
  if (argv.length !== 3 || !/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argv[1])) unavailable('usage: intent-receipt.mjs <repo-dir> <record-id> <jev-model>; approve the record first');
  const root = resolve(argv[0]);
  const filename = `${argv[1]}.md`;
  const recordText = read(join(root, 'intent', 'records', filename));
  const lawsText = read(join(root, 'intent', 'model', 'LAWS.bend'));
  // Fail before sending anything if approval hashes are stale.
  if (read(join(root, 'intent', 'model', 'laws.sha256')).trim() !== sha256(lawsText)) reject('LAWS.bend is not approved; obtain human approval and update laws.sha256 before judging');
  record(recordText, filename);
  if (record(recordText, filename).status !== 'approved') reject('record is not approved; request human approval before judging');
  const evaluator = await liveEvaluator(argv[2]);
  try {
    const receipt = await produce(recordText, lawsText, filename, argv[2], evaluator.evaluate);
    mkdirSync(join(root, 'intent', 'receipts'), { recursive: true });
    writeFileSync(join(root, 'intent', 'receipts', `${argv[1]}.json`), `${canonical(receipt)}\n`);
    console.log(`intent-receipt: ${receipt.verdict}; committed receipt must be reviewed (integrity is not a signature)`);
    if (receipt.verdict !== 'pass') reject('receipt rejects the laws; revise with approval and rerun intent-receipt');
  } finally { evaluator.close(); }
}, import.meta.url);
