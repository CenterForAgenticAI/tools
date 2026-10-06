#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INTENT_DIR, POLICY, canonical, cli, coverageQuestions, fidelityQuestions, lawIds, moduleState, modules, read, record, reject, seal, sha256, splitLaws, unavailable, verdict, verifyHeaders } from './intent-core.mjs';

// pi-fabric's Jev client caps a request at 131072 bytes by default (config maxRequestBytes, raisable to 1048576).
// Every request resends the full state (record + laws), so questions go out in batches that fit under the cap;
// answers are merged by question id. Set PI_INTENT_MAX_REQUEST_BYTES to match a raised maxRequestBytes. The Jev
// server refuses above ~32K input tokens (max_tokens_exceeded), which bites first; see TOKEN_LIMIT below.
export const REQUEST_LIMIT = 131072;
export function requestLimit(env = process.env) {
  const raw = env.PI_INTENT_MAX_REQUEST_BYTES;
  if (raw === undefined || raw === '') return REQUEST_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 16384 || n > 1048576) unavailable('PI_INTENT_MAX_REQUEST_BYTES must be an integer from 16384 to 1048576');
  return n;
}
const REQUEST_HEADROOM = 4096;
// Measured 2026-10-05 against typesafe/jev-1.13: the server rejects a request above ~32K input tokens
// (HTTP 400 max_tokens_exceeded) long before any byte cap. 32,056 tokens were accepted; ~33.1K were refused.
// Tokens are estimated offline from bytes: digit/symbol-heavy text measured 2.3 bytes per token, Bend/code about 3.0 to 3.1 (Bend-heavy 87 KB state: 3.09), prose up to 3.7.
export const TOKEN_LIMIT = 32000;
export const TOKEN_OVERHEAD = 1200; // fixed per-request cost, measured at ~1,100 tokens
export const BYTES_PER_TOKEN = 2.3; // conservative (digit-heavy text); Bend/code measured ~3.0-3.1, prose up to ~3.7
export const MAX_BYTES_PER_TOKEN = 3.7; // highest measured rate; a higher override would undercount real text and re-open the server 400
export function bytesPerToken(env = process.env) {
  const raw = env.PI_INTENT_BYTES_PER_TOKEN;
  if (raw === undefined || raw === '') return BYTES_PER_TOKEN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > MAX_BYTES_PER_TOKEN) unavailable(`PI_INTENT_BYTES_PER_TOKEN must be a number from 1 to ${MAX_BYTES_PER_TOKEN}: about 3.0 for Bend/code, 3.7 only for plain prose; a higher value undercounts tokens and the Jev server then refuses the request`);
  return n;
}
export function estimateTokens(bytes, rate = bytesPerToken()) { return Math.ceil(bytes / rate); }
const tokenAdvice = () => `Jev refuses requests above ~32K input tokens (max_tokens_exceeded); estimated at ${bytesPerToken()} bytes per token. The estimate is conservative (Bend-heavy state measured about 3.0 bytes per token). The pre-call check reserves the worst-case fidelity question (every clause on one law), so large records can be refused a little early. Shorten the record or laws, split the model per module, or set PI_INTENT_BYTES_PER_TOKEN=3.0 for Bend/code (3.7 only for plain prose, the maximum allowed)`;
export const MAX_QUESTIONS = 128; // pi-fabric checkRequest accepts 1-128 questions per request
// Law ids may be any identifier, including __proto__: build maps with Object.fromEntries (own data properties), never `obj[id] =`.
export function batches(state, questions, model = '', limit = requestLimit() - REQUEST_HEADROOM) {
  const size = value => Buffer.byteLength(JSON.stringify(value));
  const base = size({ state, questions: {}, model });
  const budget = limit - base;
  const tokenBudget = TOKEN_LIMIT - TOKEN_OVERHEAD - estimateTokens(base);
  if (tokenBudget <= 0) reject(`record, laws and model need about ${TOKEN_OVERHEAD + estimateTokens(base)} estimated tokens, over the ${TOKEN_LIMIT}-token ceiling: ${tokenAdvice()}`);
  const out = [];
  let current = [];
  let used = 0;
  let usedTokens = 0;
  for (const [id, question] of Object.entries(questions)) {
    const bytes = size(Object.fromEntries([[id, question]]));
    const tokens = estimateTokens(bytes);
    if (tokens > tokenBudget) reject(`question ${id} plus the record, laws and model is about ${TOKEN_OVERHEAD + estimateTokens(base) + tokens} estimated tokens, over the ${TOKEN_LIMIT}-token ceiling: ${tokenAdvice()}`);
    if (bytes > budget) reject(`question ${id} plus the record, laws and model exceeds ${limit} bytes; shorten the record or split the model`);
    if ((used + bytes > budget || usedTokens + tokens > tokenBudget || current.length >= MAX_QUESTIONS) && current.length) { out.push(Object.fromEntries(current)); current = []; used = 0; usedTokens = 0; }
    current.push([id, question]);
    used += bytes;
    usedTokens += tokens;
  }
  if (current.length) out.push(Object.fromEntries(current));
  return out;
}
async function judge(evaluate, state, questions, model, expectedModel) {
  let resolved = expectedModel;
  const entries = [];
  for (const batch of batches(state, questions, model)) {
    const request = { state, questions: batch, model };
    if (Buffer.byteLength(JSON.stringify(request)) > requestLimit()) reject('Jev request would exceed the request cap; shorten the record, laws or model name');
    const response = await evaluate(request);
    resolved ??= response.model;
    if (response.model !== resolved) reject('Jev returned a different model; select one explicit model and regenerate');
    // Keep only answers to questions in this batch, as own properties.
    for (const id of Object.keys(batch)) if (Object.hasOwn(response.answers ?? {}, id)) entries.push([id, response.answers[id]]);
  }
  return { model: resolved, answers: Object.fromEntries(entries) };
}
// Evaluator contract: (JevRequest) => Promise<JevResponse>. Tests inject a fake.
function checkModel(requested, got) {
  const snapshot = new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9]{8}$`);
  if (typeof got !== 'string' || (got !== requested && !snapshot.test(got))) reject('Jev returned a different model; select one explicit model and regenerate');
  return got;
}
// Judge one unit (the whole record, or one module): coverage, then fidelity. Returns the typed, projected answers.
async function judgeUnit(evaluate, state, clauses, laws, model, known) {
  const coverage = coverageQuestions(clauses, laws);
  const first = await judge(evaluate, state, coverage, model, known);
  const resolved = known ?? checkModel(model, first.model);
  const fidelity = fidelityQuestions(clauses, laws, first.answers ?? {});
  const second = await judge(evaluate, state, fidelity, model, resolved);
  // Validate raw judgments, then copy only named typed fields. Model output must
  // not inject a verdict, arbitrary metadata or subprocess options into storage.
  const computed = verdict(clauses, laws, first.answers, second.answers);
  const answers = {
    coverage: Object.fromEntries(clauses.map(c => { const a = first.answers[c.id]; return [c.id, { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries([...laws, 'none'].map(l => [l, a.probabilities[l]])) }]; })),
    fidelity: Object.fromEntries(laws.map(l => [l, { type: 'noul', noul: second.answers[l].noul }])),
  };
  return { model: resolved, questions: { coverage, fidelity }, answers, verdict: computed };
}
export async function produce(recordText, lawsText, filename, model, evaluate) {
  const rec = record(recordText, filename);
  if (rec.status !== 'approved') reject('record is not approved; request human approval before intent-receipt');
  if (typeof model !== 'string' || !model.trim()) unavailable('Jev model is required; pass a model id to intent-receipt');
  const laws = lawIds(lawsText);
  const declared = modules(recordText, rec.clauses, laws);
  // Size every request unit (the whole state, or each module) with its largest possible fidelity question (all its clauses on
  // the law with the longest id: the id is part of the question) before paying for any call. The check assumes every clause maps to that one law.
  const precheck = (state, clauses, unitLaws) => {
    const worst = unitLaws.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
    batches(state, fidelityQuestions(clauses, [worst], Object.fromEntries(clauses.map(c => [c.id, { choice: worst }]))), model);
    // A coverage question lists every law of the unit as a criterion, so with many or long law ids it can be the largest request.
    batches(state, coverageQuestions(clauses, unitLaws), model);
  };
  const head = { recordId: rec.id, recordSha256: sha256(recordText), lawsSha256: sha256(lawsText), policy: POLICY };
  if (!declared) {
    precheck({ record: recordText, laws: lawsText }, rec.clauses, laws);
    const unit = await judgeUnit(evaluate, { record: recordText, laws: lawsText }, rec.clauses, laws, model);
    return seal({ schema: 1, ...head, model: unit.model, questions: unit.questions, answers: unit.answers, verdict: unit.verdict });
  }
  // Schema 2: each module is judged against its own slice of the record and laws, so a request stays under the
  // Jev token ceiling however large the whole model is. The model snapshot must be identical across modules.
  const blocks = splitLaws(lawsText);
  for (const mod of declared) precheck(moduleState(recordText, blocks, mod), mod.clauses, mod.laws);
  let resolved;
  const entries = [];
  for (const mod of declared) {
    const state = moduleState(recordText, blocks, mod);
    const unit = await judgeUnit(evaluate, state, mod.clauses, mod.laws, model, resolved);
    resolved ??= unit.model;
    entries.push([mod.name, { clauses: mod.clauses.map(c => c.id), laws: mod.laws, stateSha256: sha256(canonical(state)), questions: unit.questions, answers: unit.answers, verdict: unit.verdict }]);
  }
  return seal({ schema: 2, ...head, model: resolved, modules: Object.fromEntries(entries), verdict: entries.every(([, e]) => e.verdict === 'pass') ? 'pass' : 'reject' });
}

export async function liveEvaluator(model, loadFabric = () => import('pi-fabric/jev')) {
  let fabric;
  try { fabric = await loadFabric(); }
  catch { unavailable('pi-fabric/jev unavailable; install pi-fabric beside the authoring project (npm install --no-save pi-fabric), configure Jev credentials, then rerun intent-receipt; CI needs neither'); }
  const target = fabric.resolveJevModelRoute(model);
  const client = new fabric.JevClient(fabric.normalizeJevConfig({ enabled: true, model, ...(requestLimit() === REQUEST_LIMIT ? {} : { maxRequestBytes: requestLimit() }) }), fetch, undefined, target.route);
  return { evaluate: request => client.evaluate(request, AbortSignal.timeout(60_000)), close: () => client.close() };
}
await cli(async argv => {
  verifyHeaders(import.meta.url);
  if (argv.length !== 3 || !/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argv[1])) unavailable('usage: intent-receipt.mjs <repo-dir> <record-id> <jev-model>; approve the record first');
  const root = resolve(argv[0]);
  const filename = `${argv[1]}.md`;
  const recordText = read(join(root, INTENT_DIR, 'records', filename));
  const lawsText = read(join(root, INTENT_DIR, 'model', 'LAWS.bend'));
  // Fail before sending anything if approval hashes are stale.
  if (read(join(root, INTENT_DIR, 'model', 'laws.sha256')).trim() !== sha256(lawsText)) reject('LAWS.bend is not approved; obtain human approval and update laws.sha256 before judging');
  record(recordText, filename);
  if (record(recordText, filename).status !== 'approved') reject('record is not approved; request human approval before judging');
  const evaluator = await liveEvaluator(argv[2]);
  try {
    const receipt = await produce(recordText, lawsText, filename, argv[2], evaluator.evaluate);
    mkdirSync(join(root, INTENT_DIR, 'receipts'), { recursive: true });
    writeFileSync(join(root, INTENT_DIR, 'receipts', `${argv[1]}.json`), `${canonical(receipt)}\n`);
    console.log(`intent-receipt: ${receipt.verdict}; committed receipt must be reviewed (integrity is not a signature)`);
    if (receipt.verdict !== 'pass') reject('receipt rejects the laws; revise with approval and rerun intent-receipt');
  } finally { evaluator.close(); }
}, import.meta.url);
