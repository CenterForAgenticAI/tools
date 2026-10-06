import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { check } from '../../kit/intent-check.mjs';
import { conform } from '../../kit/intent-conform.mjs';
import { gate } from '../../kit/intent-gate.mjs';
import { liveEvaluator, produce } from '../../kit/intent-receipt.mjs';
import { coverageQuestions, fidelityQuestions, moduleState, modules, splitLaws, FORBIDDEN_BEND, INTENT_DIR, canonical, codeOnly, hasProof, IntentError, lawIds, POLICY, record, rootArg, run, seal, sha256, verifyHeaders, verifyReceipt } from '../../kit/intent-core.mjs';
import { init, vendor } from '../../bin/pi-intent.mjs';
import { generate, validate } from '../../kit/gen-enums.mjs';
import { inventory } from '../../kit/inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const example = join(root, 'examples/transitions');
const bend = existsSync(join(homedir(), '.bend/bin/bend')) ? join(homedir(), '.bend/bin/bend') : 'bend';
const env = { ...process.env, BEND_BIN: bend, PATH: `${dirname(bend)}:${process.env.PATH}`, PYTHONDONTWRITEBYTECODE: '1' };
const text = path => readFileSync(path, 'utf8');
const fixtureRecord = text(join(example, 'intent/records/0001-transitions.md'));
const fixtureLaws = text(join(example, 'intent/model/LAWS.bend'));
const stored = JSON.parse(text(join(example, 'intent/receipts/0001-transitions.json')));
const rec = record(fixtureRecord, '0001-transitions.md');
const fake = async request => ({ model: request.model, answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, request.questions[id].type === 'choice' ? { ...stored.answers.coverage[id], injected: 'must not survive' } : { ...stored.answers.fidelity[id], injected: 'must not survive' }])), verdict: 'model must not decide', usage: { input_tokens: 0, output_tokens: 0 } });
function fixture(t) {
  mkdirSync(join(root, '.scratch'), { recursive: true });
  const dir = mkdtempSync(join(root, '.scratch/intent-test-'));
  cpSync(example, dir, { recursive: true, filter: p => !p.includes('/target') && !p.includes('__pycache__') });
  renameSync(join(dir, 'intent'), join(dir, INTENT_DIR));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj)); }
function command(script, dir, args = []) { return spawnSync(process.execPath, [join(root, script), dir, ...args], { encoding: 'utf8', env, timeout: 180000 }); }
function smallManifest(dir, overrides = {}) {
  const check = { name: 'small', laws: ['stopped_rejects', 'active_allows'], model: [process.execPath, '-e', 'console.log("a\\nb")'], real: [process.execPath, '-e', 'console.log("b\\na")'], broken: [process.execPath, '-e', 'console.log("wrong")'], ...overrides };
  writeJson(join(dir, '.intent/conform.json'), { schema: 1, checks: [check] });
  return check;
}

test('offline receipt production uses typed Jev shape, strips injected fields and recomputes verdict', async () => {
  const requests = [];
  const receipt = await produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => { requests.push(r); return fake(r); });
  assert.equal(receipt.verdict, 'pass');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].questions.R1.type, 'choice');
  assert.equal(requests[1].questions.stopped_rejects.type, 'noul');
  assert.match(requests[1].questions.stopped_rejects.instructions, /R1/);
  assert.ok(!JSON.stringify(receipt).includes('injected'));
  assert.ok(!JSON.stringify(receipt).includes('model must not decide'));
  verifyReceipt(receipt, rec, fixtureLaws, fixtureRecord);
  const rejected = await produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => {
    const response = await fake(r);
    if (r.questions.stopped_rejects) response.answers.stopped_rejects.noul = 0.89;
    return response;
  });
  assert.equal(rejected.verdict, 'reject');
  assert.throws(() => verifyReceipt(rejected, rec, fixtureLaws, fixtureRecord), /policy rejects/);
});

for (const [model, routeId] of [['jev-1.13', 'typesafe'], ['typesafe/jev-1.13', 'openrouter'], ['typesafe-ai/jev', 'vercel-ai-gateway']]) test(`live evaluator passes the resolved ${routeId} route to the client`, async () => {
  const route = { id: routeId };
  const request = { model, questions: {} };
  let evaluated = false;
  let closed = false;
  const evaluator = await liveEvaluator(model, async () => ({
    resolveJevModelRoute: id => { assert.equal(id, model); return { route, model: id }; },
    normalizeJevConfig: config => { assert.deepEqual(config, { enabled: true, model }); return config; },
    JevClient: class {
      constructor(config, fetcher, options, selectedRoute) {
        assert.equal(config.model, model);
        assert.equal(fetcher, fetch);
        assert.equal(options, undefined);
        assert.equal(selectedRoute, route);
      }
      async evaluate(input, signal) { assert.equal(input, request); assert.ok(signal instanceof AbortSignal); evaluated = true; return { model }; }
      close() { closed = true; }
    },
  }));
  assert.deepEqual(await evaluator.evaluate(request), { model });
  evaluator.close();
  assert.ok(evaluated && closed);
});

test('dated Jev snapshot is recorded and accepted by the offline check', async t => {
  const model = 'typesafe/jev-1.13';
  const receipt = await produce(fixtureRecord, fixtureLaws, '0001-transitions.md', model, async request => {
    assert.equal(request.model, model);
    return { ...await fake(request), model: `${model}-20260917` };
  });
  assert.equal(receipt.model, 'typesafe/jev-1.13-20260917');
  assert.equal(receipt.verdict, 'pass');
  const dir = fixture(t);
  writeJson(join(dir, '.intent/receipts/0001-transitions.json'), receipt);
  assert.match(check(dir), /ok/);
});

test('Jev evaluations must echo the same snapshot, not two individually valid model ids', async () => {
  const model = 'typesafe/jev-1.13';
  for (const second of [`${model}-20260918`, model]) {
    let calls = 0;
    await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', model, async request => ({
      ...await fake(request), model: ++calls === 1 ? `${model}-20260917` : second,
    })), /different model/);
  }
});

test('Jev snapshot matching treats regex metacharacters literally and rejects unrelated echoes', async () => {
  const model = 'typesafe/jev-1.13';
  for (const echo of ['unrelated/model-20260917', 'typesafe/jev-1x13-20260917', `${model}-20260917-extra`, `${model}-2026091`, `${model}-20260917\n`]) {
    await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', model, async request => ({ ...await fake(request), model: echo })), /different model/);
  }
  const metaModel = 'test/model+[v1](x)?';
  const receipt = await produce(fixtureRecord, fixtureLaws, '0001-transitions.md', metaModel, async request => ({ ...await fake(request), model: `${metaModel}-20260917` }));
  assert.equal(receipt.model, `${metaModel}-20260917`);
  await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', metaModel, async request => ({ ...await fake(request), model: 'test/modellv1x-20260917' })), /different model/);
});

test('offline check detects laws, record and receipt edits and altered policy', t => {
  const dir = fixture(t);
  assert.match(check(dir), /ok/);
  const path = join(dir, '.intent/receipts/0001-transitions.json');
  writeJson(path, { ...stored, model: 'hand edited' });
  assert.throws(() => check(dir), /hand-edited/);
  writeJson(path, stored);
  writeFileSync(join(dir, '.intent/model/LAWS.bend'), fixtureLaws + '\n# changed');
  assert.throws(() => check(dir), /changed since approval/);
  writeFileSync(join(dir, '.intent/model/laws.sha256'), sha256(fixtureLaws + '\n# changed'));
  assert.throws(() => check(dir), /hashes are stale/);
  writeFileSync(join(dir, '.intent/model/LAWS.bend'), fixtureLaws);
  writeFileSync(join(dir, '.intent/model/laws.sha256'), sha256(fixtureLaws));
  writeFileSync(join(dir, '.intent/records/0001-transitions.md'), fixtureRecord + '\nchanged');
  assert.throws(() => check(dir), /hashes are stale/);
  const body = structuredClone(stored);
  delete body.integrity;
  assert.throws(() => verifyReceipt(seal({ ...body, policy: { ...POLICY, fidelityThreshold: 0 } }), rec, fixtureLaws, fixtureRecord), /policy/);
  assert.throws(() => verifyReceipt({ ...stored, extra: true }, rec, fixtureLaws, fixtureRecord), /format/);
  assert.throws(() => verifyReceipt(seal({ ...body, questions: {} }), rec, fixtureLaws, fixtureRecord), /questions/);
  assert.throws(() => verifyReceipt(seal({ ...body, verdict: 'reject' }), rec, fixtureLaws, fixtureRecord), /policy rejects/);
});

test('receipt policy rejects malformed, missing and none judgments', async () => {
  for (const mutation of [
    r => { delete r.answers.R1; },
    r => { r.answers.R1.type = 'score'; },
    r => { r.answers.R1.probabilities.none = 2; },
    r => { r.answers.R1.confidence = NaN; },
  ]) await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => { const response = structuredClone(await fake(r)); if (r.questions.R1) mutation(response); return response; }), /receipt/);
  const none = await produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => { const response = structuredClone(await fake(r)); if (r.questions.R1) response.answers.R1 = { type: 'choice', choice: 'none', confidence: 1, probabilities: { stopped_rejects: 0, active_allows: 0, none: 1 } }; return response; });
  assert.equal(none.verdict, 'reject');
  await assert.rejects(produce(fixtureRecord.replace('status: approved', 'status: draft'), fixtureLaws, '0001-transitions.md', 'fixture/fake', fake), /not approved/);
  await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', '', fake), /model/);
  await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => ({ ...await fake(r), model: 'wrong' })), /different model/);
  let calls = 0;
  await assert.rejects(produce(fixtureRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => ({ ...await fake(r), model: ++calls === 2 ? 'wrong' : r.model })), /different model/);
});

test('record structure rejects missing sections, mismatched ids and noncontiguous rules', t => {
  assert.throws(() => record(fixtureRecord, 'other.md'), /id or status/);
  for (const replacement of [['## Freedoms', '## Freedom'], ['context: ./CONTEXT.md', ''], ['R2:', 'R3:'], ['approved-by:', 'author:']]) assert.throws(() => record(fixtureRecord.replace(...replacement), '0001-transitions.md'));
  assert.throws(() => lawIds('# law hidden:\n'), /empty/);
  assert.throws(() => lawIds('law a:\nlaw a:\n'), /duplicate/);
  assert.throws(() => lawIds('law none:\n'), /reserved/);
  assert.equal(codeOnly('"@unsafe" # ?TODO\ndef f():\n  True{}').includes('@unsafe'), false);
  const dir = fixture(t);
  writeFileSync(join(dir, '.intent/records/0001-transitions.md'), fixtureRecord.replace('status: approved', 'status: descriptive'));
  assert.throws(() => check(dir), /no approved/);
  rmSync(join(dir, '.intent/records/0001-transitions.md'));
  assert.throws(() => check(dir), /empty/);
  assert.equal(rootArg([]), root);
  assert.throws(() => rootArg(['--wrong']), /unknown/);
  assert.throws(() => rootArg(['a', 'b']), /unknown/);
  assert.throws(() => check(join(dir, 'missing')), e => e instanceof IntentError && e.code === 2);
});

test('vendor headers detect drift in check itself and shared scripts; init never approves', t => {
  const dir = fixture(t);
  assert.equal(INTENT_DIR, '.intent');
  assert.equal(existsSync(join(dir, 'intent')), false);
  assert.match(check(dir), /ok/); // Moving fixture bytes preserves the bound receipt.
  vendor(dir);
  assert.equal(existsSync(join(dir, 'tools')), false);
  for (const parts of [['tools'], ['other', 'tools'], [INTENT_DIR, 'not-tools']]) {
    verifyHeaders(pathToFileURL(join(dir, ...parts, 'intent-check.mjs')));
  }
  writeFileSync(join(dir, '.intent/tools/unrelated.mjs'), '// app-owned tool, not vendored by pi-intent');
  const checked = spawnSync(process.execPath, [join(dir, '.intent/tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr);
  for (const name of ['intent-check.mjs', 'intent-core.mjs']) {
    vendor(dir);
    writeFileSync(join(dir, INTENT_DIR, 'tools', name), text(join(dir, INTENT_DIR, 'tools', name)) + '\n// accidental drift');
    const result = spawnSync(process.execPath, [join(dir, '.intent/tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale.*header/);
  }
  vendor(dir);
  const corePath = join(dir, '.intent/tools/intent-core.mjs');
  writeFileSync(corePath, text(corePath).replace(`v${JSON.parse(text(join(root, 'package.json'))).version}`, 'v0.0.0'));
  assert.equal(spawnSync(process.execPath, [join(dir, '.intent/tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 }).status, 1);
  const target = join(dir, 'new-app');
  init(target);
  assert.match(text(join(target, '.intent/records/0001-change.md')), /status: draft/);
  assert.equal(command('kit/intent-check.mjs', target).status, 1);
  assert.throws(() => init(target), /\.intent\/ already exists/);
  const recordPath = join(target, INTENT_DIR, 'records/0001-change.md');
  const draft = text(recordPath);
  assert.throws(() => init(target), /already exists/);
  assert.equal(text(recordPath), draft, 'init must preserve existing adopter state');
  renameSync(join(dir, INTENT_DIR), join(dir, 'intent'));
  assert.throws(() => check(dir), /\.intent\/records unavailable/, 'legacy visible state must not be silently accepted');
});

test('Bend gate proves laws and rejects both negatives and bypass constructs', async t => {
  const dir = fixture(t);
  await gate(dir, bend);
  for (const snippet of ['@unsafe', 'def bypass?(x):\n  x', '?TODO']) {
    writeFileSync(join(dir, '.intent/model/Bypass.bend'), snippet);
    await assert.rejects(gate(dir, bend), /forbidden/);
  }
  rmSync(join(dir, '.intent/model/Bypass.bend'));
  symlinkSync(join(dir, '.intent/model/LAWS.bend'), join(dir, '.intent/model/Alias.bend'));
  await assert.rejects(gate(dir, bend), /symlink/);
  rmSync(join(dir, '.intent/model/Alias.bend'));
  writeFileSync(join(dir, '.intent/model/neg/stopped.bend'), text(join(dir, '.intent/model/PROOF.bend')).replace('./LAWS.bend', '../LAWS.bend') + '\n# expect-failure: M.stopped_rejects');
  await assert.rejects(gate(dir, bend), /control did not fail/);
  writeFileSync(join(dir, '.intent/model/neg/stopped.bend'), 'import Missing\n# expect-failure: Missing\n');
  await assert.rejects(gate(dir, bend), /unrelated law/);
  writeFileSync(join(dir, '.intent/model/neg/stopped.bend'), 'import Base');
  await assert.rejects(gate(dir, bend), /missing # expect-failure/);
  rmSync(join(dir, '.intent/model/neg'), { recursive: true });
  await assert.rejects(gate(dir, bend), /empty/);
});

test('gate rejects orphaned laws, failed proofs and unavailable Bend', async t => {
  const dir = fixture(t);
  await assert.rejects(gate(dir, join(dir, 'no-bend')), e => e.code === 2);
  writeFileSync(join(dir, '.intent/model/Unimported.bend'), 'import Base\nlaw helper:\n  Unit\ndef helper():\n  False{}\n');
  await assert.rejects(gate(dir, bend), /Unimported.bend did not check/);
  rmSync(join(dir, '.intent/model/Unimported.bend'));
  writeFileSync(join(dir, '.intent/model/PROOF.bend'), 'import Base');
  await assert.rejects(gate(dir, bend), /no proof def/);
  writeFileSync(join(dir, '.intent/model/PROOF.bend'), text(join(example, 'intent/model/PROOF.bend')).replace('def M.stopped_rejects(to):\n  {==}', 'def M.stopped_rejects(to):\n  Unit{}'));
  await assert.rejects(gate(dir, bend), /did not check/);
});

for (const language of ['typescript', 'go', 'python', 'rust']) test(`${language} oracle executes app code, matches all 16 Bend cases and differs from broken model`, t => {
  if (language === 'rust' && spawnSync('cargo', ['--version'], { timeout: 5000 }).error) return t.skip('cargo is not on PATH; Rust conformance unavailable');
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, '.intent/conform.json')));
  manifest.checks = manifest.checks.filter(c => c.name === language);
  writeJson(join(dir, '.intent/conform.json'), manifest);
  const result = command('kit/intent-conform.mjs', dir, ['--require-coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /16 cases; broken model differs/);
  assert.match(result.stdout, /uncovered laws: none/);
});

test('real implementation drift fails with disagreeing cases', t => {
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, '.intent/conform.json')));
  manifest.checks = manifest.checks.filter(c => c.name === 'typescript');
  writeJson(join(dir, '.intent/conform.json'), manifest);
  writeFileSync(join(dir, 'src/session.ts'), text(join(dir, 'src/session.ts')).replace("from !== 'not-running'", "from === 'not-running'"));
  const result = command('kit/intent-conform.mjs', dir);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /conformance drift/);
  assert.match(result.stderr, /idle->working true/);
});

test('a retyped oracle agrees with deliberately wrong model and is rejected', t => {
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, '.intent/conform.json')));
  const c = manifest.checks[0];
  // A wrong, retyped "real" oracle and model both claim every transition rejects.
  c.model = c.broken;
  c.real = [process.execPath, '-e', 'for(const f of ["idle","working","blocked","not-running"]) for(const t of ["idle","working","blocked","not-running"]) console.log(`${f}->${t} false`)'];
  manifest.checks = [c];
  writeJson(join(dir, '.intent/conform.json'), manifest);
  const result = command('kit/intent-conform.mjs', dir);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /oracle does not exercise the real code/);
});

test('conformance sorts lines, enforces coverage, validates laws before executing', async t => {
  const dir = fixture(t);
  smallManifest(dir);
  await conform(dir, true);
  smallManifest(dir, { laws: ['stopped_rejects'] });
  await conform(dir);
  await assert.rejects(conform(dir, true), /coverage incomplete/);
  smallManifest(dir, { laws: ['unknown'] });
  await assert.rejects(conform(dir), /not declared/);
  for (const override of [{ real: 'echo a' }, { timeoutMs: 0 }, { cwd: 3 }, { name: '' }, { laws: [] }]) {
    smallManifest(dir, override);
    await assert.rejects(conform(dir), e => e.code === 2);
  }
  writeFileSync(join(dir, '.intent/conform.json'), '{');
  await assert.rejects(conform(dir), /invalid JSON/);
  writeJson(join(dir, '.intent/conform.json'), { schema: 1, checks: [] });
  await assert.rejects(conform(dir), /nonempty/);
});

test('hostile shell metacharacters and shell:true remain data, not shell execution', async t => {
  const dir = fixture(t);
  const literal = 'value; touch OWNED $(touch ALSO_OWNED) `touch THIRD` > FOURTH &';
  const argv = [process.execPath, '-e', 'console.log(process.argv[1])', literal];
  smallManifest(dir, { model: argv, real: argv, shell: true, maxBuffer: Infinity });
  await conform(dir, true);
  for (const name of ['OWNED', 'ALSO_OWNED', 'THIRD', 'FOURTH']) assert.equal(existsSync(join(dir, name)), false);
  const result = await run(argv, dir);
  assert.equal(result.stdout.trim(), literal);
});

test('timeouts, output caps, missing tools, empty output and failed commands fail closed', async t => {
  const dir = fixture(t);
  for (const argv of [[], [''], ['a\0b'], 'echo a']) await assert.rejects(run(argv, dir), e => e.code === 2);
  await assert.rejects(run([process.execPath, '-e', 'setTimeout(()=>{},5000)'], dir, 20), e => e.code === 2);
  await assert.rejects(run([process.execPath, '-e', 'process.stdout.write("x".repeat(2**22))'], dir), e => e.code === 2);
  await assert.rejects(run(['no-such-pi-intent-command'], dir), e => e.code === 2);
  await assert.rejects(run([process.execPath], dir, 600001), e => e.code === 2);
  smallManifest(dir, { real: [process.execPath, '-e', 'process.exit(3)'] });
  await assert.rejects(conform(dir), /exited 3/);
  smallManifest(dir, { real: [process.execPath, '-e', ''] });
  await assert.rejects(conform(dir), /emitted no cases/);
});

test('CLI exit codes distinguish rejection and input gaps; no live Jev is called', t => {
  const dir = fixture(t);
  assert.equal(command('kit/intent-check.mjs', dir).status, 0);
  assert.equal(command('kit/intent-check.mjs', dir, ['--bogus']).status, 2);
  const judge = command('kit/intent-receipt.mjs', dir, ['0001-transitions', 'fixture/fake']);
  assert.equal(judge.status, 2, judge.stderr);
  assert.match(judge.stderr, /install.*pi-fabric/);
  assert.equal(command('bin/pi-intent.mjs', dir).status, 2);
  const missing = command('kit/intent-check.mjs', join(dir, 'missing'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /unavailable/);
  assert.equal(command('kit/intent-receipt.mjs', dir).status, 2);
});

test('ported Bend helpers generate checking enum proofs and report law inventory', async t => {
  const dir = fixture(t);
  const spec = { enums: [{ name: 'Flag', cases: [{ ctor: 'Off', key: 'off' }, { ctor: 'On', key: 'on' }] }] };
  validate(spec);
  writeFileSync(join(dir, '.intent/model/Flag.bend'), generate(spec));
  const result = await run([bend, 'Flag.bend', '--check-only'], join(dir, '.intent/model'), 120000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /ALL PROOFS CHECK/);
  const inv = inventory(join(dir, '.intent/model'));
  assert.ok(inv.declarations.some(d => d.id === 'stopped_rejects' && d.status === 'defined'));
  assert.ok(inv.counts.constructor > 0);
  assert.equal(hasProof('/a/L.bend', 'law', '/a/P.bend', 'import ./Other.bend as M\ndef M.law(x):'), false);
  assert.equal(hasProof('/a/L.bend', 'law', '/a/L.bend', 'def law(x):'), true);
  writeFileSync(join(dir, '.intent/model/PROOF.bend'), 'import ./Rows.bend as M\ndef M.stopped_rejects(to):\n  {==}\ndef M.active_allows(from,to):\n  {==}');
  assert.equal(inventory(join(dir, '.intent/model')).declarations.find(d => d.id === 'stopped_rejects').status, 'open');
  await assert.rejects(gate(dir, bend), /no proof def resolving/);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('receipt production batches large requests under the Jev limit and merges answers', async t => {
  // Byte batching only binds above about 4.1 B/token at the default 131072-byte cap, and the rate is capped at 3.7,
  // so this test lowers the byte cap (64 KiB) and uses the prose rate to exercise byte batching alone.
  const saved = { r: process.env.PI_INTENT_BYTES_PER_TOKEN, m: process.env.PI_INTENT_MAX_REQUEST_BYTES };
  process.env.PI_INTENT_BYTES_PER_TOKEN = '3.7';
  process.env.PI_INTENT_MAX_REQUEST_BYTES = '65536';
  t.after(() => { for (const [k, v] of [['PI_INTENT_BYTES_PER_TOKEN', saved.r], ['PI_INTENT_MAX_REQUEST_BYTES', saved.m]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const REQUEST_LIMIT = 65536;
  const filler = '\n# ' + 'x'.repeat(20000);
  const bigLaws = fixtureLaws + filler;
  const requests = [];
  const evaluate = async r => { requests.push(r); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= REQUEST_LIMIT); return fake(r); };
  // Pad the state so the questions cannot fit in one request.
  const biggest = Math.max(...Object.values({ ...coverageQuestions(rec.clauses, lawIds(fixtureLaws)), ...fidelityQuestions(rec.clauses, lawIds(fixtureLaws), {}) }).map(q => Buffer.byteLength(JSON.stringify(q)) + 20));
  const pad = REQUEST_LIMIT - 4096 - Math.ceil(biggest * 1.5) - Buffer.byteLength(JSON.stringify({ state: { record: fixtureRecord, laws: bigLaws }, questions: {}, model: 'fixture/fake' }));
  const laws = bigLaws + '\n# ' + 'y'.repeat(Math.max(pad, 0));
  const receipt = await produce(fixtureRecord, laws, '0001-transitions.md', 'fixture/fake', evaluate);
  assert.ok(requests.length > 2, 'expected several batches, got ' + requests.length);
  assert.equal(Object.keys(receipt.answers.coverage).length, rec.clauses.length);
  assert.equal(Object.keys(receipt.answers.fidelity).length, lawIds(laws).length);
  verifyReceipt(receipt, rec, laws, fixtureRecord);
  // A model change between batches is rejected.
  let n = 0;
  await assert.rejects(produce(fixtureRecord, laws, '0001-transitions.md', 'fixture/fake', async r => ({ ...await fake(r), model: ++n > 1 ? 'fixture/other' : 'fixture/fake' })), /different model/);
  // State that leaves no room for a question is rejected with guidance.
  await assert.rejects(produce(fixtureRecord, laws + 'z'.repeat(10000), '0001-transitions.md', 'fixture/fake', fake), /exceeds \d+ bytes/);
});

test('request limit defaults to pi-fabric\'s cap and honours a valid PI_INTENT_MAX_REQUEST_BYTES', async () => {
  const { requestLimit, REQUEST_LIMIT } = await import('../../kit/intent-receipt.mjs');
  assert.equal(requestLimit({}), REQUEST_LIMIT);
  assert.equal(requestLimit({ PI_INTENT_MAX_REQUEST_BYTES: '1048576' }), 1048576);
  for (const bad of ['abc', '100', '2000000', '1.5']) assert.throws(() => requestLimit({ PI_INTENT_MAX_REQUEST_BYTES: bad }), e => e.code === 2);
});

test('batches never exceed 128 questions even when bytes would allow more', async () => {
  const { batches, MAX_QUESTIONS } = await import('../../kit/intent-receipt.mjs');
  const questions = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['Q' + i, { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } }]));
  const out = batches({ record: 'r', laws: 'l' }, questions, 'm');
  assert.equal(MAX_QUESTIONS, 128);
  assert.deepEqual(out.map(b => Object.keys(b).length), [128, 128, 44]);
  assert.equal(Object.keys(Object.assign({}, ...out)).length, 300);
});

test('receipt production keeps __proto__ law ids and stays under the cap with a long model name', async () => {
  const { REQUEST_LIMIT } = await import('../../kit/intent-receipt.mjs');
  const laws = fixtureLaws.replaceAll('stopped_rejects', '__proto__');
  const evaluate = async r => {
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= REQUEST_LIMIT);
    const answers = Object.create(null);
    for (const id of Object.keys(r.questions)) {
      const base = r.questions[id].type === 'choice' ? stored.answers.coverage[id === 'R1' ? 'R1' : id] : { type: 'noul', noul: 0.99 };
      Object.defineProperty(answers, id, { value: base.type === 'choice' ? { ...base, choice: base.choice === 'stopped_rejects' ? '__proto__' : base.choice, probabilities: Object.fromEntries(Object.entries(base.probabilities).map(([k, v]) => [k === 'stopped_rejects' ? '__proto__' : k, v])) } : base, enumerable: true });
    }
    return { model: r.model, answers };
  };
  const long = 'm'.repeat(10000);
  const receipt = await produce(fixtureRecord, laws, '0001-transitions.md', long, evaluate);
  assert.equal(receipt.verdict, 'pass');
  assert.ok(Object.hasOwn(receipt.answers.fidelity, '__proto__'));
});

test('a raised request cap reaches the live Jev client config, the default does not', async () => {
  const seen = [];
  const load = async () => ({
    resolveJevModelRoute: () => ({ route: 'r' }),
    normalizeJevConfig: config => { seen.push(config); return config; },
    JevClient: class { close() {} },
  });
  const saved = process.env.PI_INTENT_MAX_REQUEST_BYTES;
  try {
    delete process.env.PI_INTENT_MAX_REQUEST_BYTES;
    (await liveEvaluator('m/x', load)).close();
    process.env.PI_INTENT_MAX_REQUEST_BYTES = '262144';
    (await liveEvaluator('m/x', load)).close();
  } finally {
    if (saved === undefined) delete process.env.PI_INTENT_MAX_REQUEST_BYTES; else process.env.PI_INTENT_MAX_REQUEST_BYTES = saved;
  }
  assert.deepEqual(seen, [{ enabled: true, model: 'm/x' }, { enabled: true, model: 'm/x', maxRequestBytes: 262144 }]);
});

test('token estimate: offline, conservative, overridable, bad override is unavailable', async () => {
  const { estimateTokens, bytesPerToken, BYTES_PER_TOKEN, MAX_BYTES_PER_TOKEN, TOKEN_LIMIT } = await import('../../kit/intent-receipt.mjs');
  assert.equal(TOKEN_LIMIT, 32000);
  assert.equal(bytesPerToken({}), BYTES_PER_TOKEN);
  assert.equal(bytesPerToken({ PI_INTENT_BYTES_PER_TOKEN: '3.7' }), 3.7);
  assert.equal(MAX_BYTES_PER_TOKEN, 3.7);
  assert.throws(() => bytesPerToken({ PI_INTENT_BYTES_PER_TOKEN: '4' }), e => e.code === 2 && /3\.7/.test(e.message) && /about 3\.0 for Bend/.test(e.message));
  assert.equal(estimateTokens(2000, 2), 1000);
  // Measured against the live server: 73,594 digit-heavy bytes were 31,985 tokens; the estimate must not undercount that.
  assert.ok(estimateTokens(73594, BYTES_PER_TOKEN) >= 31985);
  for (const bad of ['abc', '0.5', '3.8', '6', '7']) assert.throws(() => bytesPerToken({ PI_INTENT_BYTES_PER_TOKEN: bad }), e => e.code === 2);
});

test('state over the 32K-token ceiling is rejected before any Jev call, naming the ceiling', async () => {
  const { batches } = await import('../../kit/intent-receipt.mjs');
  let calls = 0;
  const evaluate = async r => { calls++; return fake(r); };
  // ~80 KB is under the 128 KiB byte cap but about 35K estimated tokens.
  const laws = fixtureLaws + '\n# ' + 'x'.repeat(80000);
  await assert.rejects(produce(fixtureRecord, laws, '0001-transitions.md', 'fixture/fake', evaluate), e => e.code === 1 && /32K input tokens/.test(e.message) && /max_tokens_exceeded/.test(e.message));
  assert.equal(calls, 0);
  assert.throws(() => batches({ record: 'r', laws: 'x'.repeat(80000) }, { Q: { type: 'noul', instructions: 'x', criteria: {} } }, 'm'), /32000-token ceiling/);
});

test('a single question that would push the request over the token ceiling is rejected; a prose estimate lets the same state through', async () => {
  const { batches } = await import('../../kit/intent-receipt.mjs');
  const state = { record: 'r', laws: 'x'.repeat(66000) };
  const big = { type: 'noul', instructions: 'y'.repeat(6000), criteria: { true: 'a', false: 'b' } };
  assert.throws(() => batches(state, { Q: big }, 'm'), /estimated tokens, over the 32000-token ceiling/);
  const saved = process.env.PI_INTENT_BYTES_PER_TOKEN;
  try {
    process.env.PI_INTENT_BYTES_PER_TOKEN = '3.7';
    assert.deepEqual(Object.keys(batches(state, { Q: big }, 'm')[0]), ['Q']);
  } finally {
    if (saved === undefined) delete process.env.PI_INTENT_BYTES_PER_TOKEN; else process.env.PI_INTENT_BYTES_PER_TOKEN = saved;
  }
});

test('token budget splits questions into more batches than bytes alone and every request stays under the estimate', async () => {
  const { batches, estimateTokens, TOKEN_LIMIT, TOKEN_OVERHEAD } = await import('../../kit/intent-receipt.mjs');
  const state = { record: 'r', laws: 'x'.repeat(40000) };
  const questions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['Q' + i, { type: 'noul', instructions: 'z'.repeat(1000), criteria: { true: 'a', false: 'b' } }]));
  const out = batches(state, questions, 'm');
  assert.ok(out.length > 1, 'bytes alone (128 KiB) would fit all 40 in one request');
  for (const b of out) assert.ok(TOKEN_OVERHEAD + estimateTokens(Buffer.byteLength(JSON.stringify({ state, questions: b, model: 'm' }))) <= TOKEN_LIMIT);
  assert.equal(Object.keys(Object.assign({}, ...out)).length, 40);
});

test('the whole state and the largest fidelity question are budgeted before any coverage call is paid for', async () => {
  const { estimateTokens, TOKEN_LIMIT, TOKEN_OVERHEAD, batches } = await import('../../kit/intent-receipt.mjs');
  const ids = lawIds(fixtureLaws);
  const size = v => Buffer.byteLength(JSON.stringify(v));
  const cov = coverageQuestions(rec.clauses, ids);
  const allOnOne = fidelityQuestions(rec.clauses, [ids[0]], Object.fromEntries(rec.clauses.map(c => [c.id, { choice: ids[0] }])));
  const maxCov = Math.max(...Object.entries(cov).map(([k, q]) => size({ [k]: q })));
  const fid = size(allOnOne);
  assert.ok(fid > maxCov, 'fixture: the all-clauses fidelity question must be bigger than any coverage question');
  // Pad the laws so every coverage question fits but the all-clauses fidelity question does not.
  const room = bytes => TOKEN_LIMIT - TOKEN_OVERHEAD - estimateTokens(size({ state: { record: fixtureRecord, laws: fixtureLaws + '\n# ' + 'p'.repeat(bytes) }, questions: {}, model: 'fixture/fake' }));
  let pad = 0;
  while (estimateTokens(maxCov) < room(pad + 50) && estimateTokens(fid) <= room(pad)) pad += 50;
  const laws = fixtureLaws + '\n# ' + 'p'.repeat(pad);
  const state = { record: fixtureRecord, laws };
  assert.doesNotThrow(() => batches(state, cov, 'fixture/fake'));
  assert.throws(() => batches(state, allOnOne, 'fixture/fake'), /estimated tokens/);
  let calls = 0;
  await assert.rejects(produce(fixtureRecord, laws, '0001-transitions.md', 'fixture/fake', async r => { calls++; return fake(r); }), e => e.code === 1 && /32000-token ceiling/.test(e.message));
  assert.equal(calls, 0, 'no coverage call may be paid for when the fidelity phase cannot fit');
});

test('the fidelity precheck sizes the longest law id, not the first', async () => {
  const { estimateTokens, TOKEN_LIMIT, TOKEN_OVERHEAD, batches } = await import('../../kit/intent-receipt.mjs');
  const size = v => Buffer.byteLength(JSON.stringify(v));
  const longId = 'L' + 'o'.repeat(300);
  const base = fixtureLaws + '\nlaw ' + longId + ': true\n';
  const ids = lawIds(base);
  assert.ok(ids.includes(longId) && ids[0] !== longId, 'fixture: a short id must come first');
  const allOn = id => fidelityQuestions(rec.clauses, [id], Object.fromEntries(rec.clauses.map(c => [c.id, { choice: id }])));
  const room = pad => TOKEN_LIMIT - TOKEN_OVERHEAD - estimateTokens(size({ state: { record: fixtureRecord, laws: base + '\n# ' + 'p'.repeat(pad) }, questions: {}, model: 'fixture/fake' }));
  let pad = 0;
  // Smallest pad at which the all-clauses question on the long id no longer fits; the one on the first id must still fit.
  while (estimateTokens(size(allOn(longId))) <= room(pad)) { pad++; assert.ok(pad < 200000, 'no window'); }
  assert.ok(estimateTokens(size(allOn(ids[0]))) <= room(pad), 'fixture: window between the short and the long id');
  const laws = base + '\n# ' + 'p'.repeat(pad);
  assert.doesNotThrow(() => batches({ record: fixtureRecord, laws }, allOn(ids[0]), 'fixture/fake'));
  assert.throws(() => batches({ record: fixtureRecord, laws }, allOn(longId), 'fixture/fake'), /estimated tokens/);
  let calls = 0;
  await assert.rejects(produce(fixtureRecord, laws, '0001-transitions.md', 'fixture/fake', async r => { calls++; return fake(r); }), e => e.code === 1);
  assert.equal(calls, 0);
});

// --- per-module state (receipt schema 2) ---
const modRecord = fixtureRecord.replace('## Freedoms', '## Modules\n- stopping: R1; laws: stopped_rejects\n- running: R2; laws: active_allows\n\n## Freedoms');
const modRec = record(modRecord, '0001-transitions.md');
const modLawIds = lawIds(fixtureLaws);
const pick = { R1: 'stopped_rejects', R2: 'active_allows' };
const modFake = async r => ({ model: r.model, answers: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, q.type === 'choice'
  ? { type: 'choice', choice: pick[id], confidence: 0.95, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === pick[id] ? 0.95 : 0.05 / (Object.keys(q.criteria).length - 1)])) }
  : { type: 'noul', noul: 0.95 }])) });
const reseal = (receipt, change) => { const body = structuredClone(receipt); delete body.integrity; return seal(change(body)); };

test('modules parse, validate and reject every ambiguous assignment', () => {
  const parsed = modules(modRecord, modRec.clauses, modLawIds);
  assert.deepEqual(parsed.map(m => [m.name, m.clauses.map(c => c.id), m.laws]), [['stopping', ['R1'], ['stopped_rejects']], ['running', ['R2'], ['active_allows']]]);
  assert.equal(modules(fixtureRecord, rec.clauses, modLawIds), null);
  const bad = (section, pattern) => assert.throws(() => modules(fixtureRecord.replace('## Freedoms', `## Modules\n${section}\n\n## Freedoms`), rec.clauses, modLawIds), pattern);
  bad('- a: R1; laws: stopped_rejects', /clause\(s\) R2 are in no module/);
  bad('- a: R1, R2; laws: stopped_rejects', /law\(s\) active_allows are in no module/);
  bad('- a: R1; laws: stopped_rejects\n- b: R1-R2; laws: active_allows', /clause R1 is in both module a and b/);
  bad('- a: R1-R2; laws: stopped_rejects\n- b: R3; laws: active_allows', /clause R1 is in both|unknown clause R3/);
  bad('- a: R1, R2; laws: stopped_rejects, active_allows\n- b: R1; laws: none_such', /clause R1 is in both/);
  bad('- a: R1; laws: stopped_rejects\n- b: R2; laws: stopped_rejects, active_allows', /law stopped_rejects is in both module a and b/);
  bad('- a: R1; laws: stopped_*, active_*\n- b: R2; laws: active_allows', /law active_allows is in both module a and b/);
  bad('- a: R1, R2; laws: nothing_*', /matches no law/);
  bad('- a: R2-R1; laws: stopped_rejects', /runs backwards/);
  bad('- __proto__: R1, R2; laws: stopped_rejects, active_allows', /bad Modules line/);
  bad('- a: R1; laws: stopped_rejects\n- a: R2; laws: active_allows', /duplicate module a/);
  bad('- a: R1; laws: stopped_rejects\nsome prose\n- b: R2; laws: active_allows', /bad Modules line/);
  assert.throws(() => modules(modRecord.replace('## Freedoms', '## Modules\n- c: R1; laws: x\n\n## Freedoms'), modRec.clauses, modLawIds), /duplicate Modules section/);
  // A prefix glob is allowed and matches several laws.
  assert.deepEqual(modules(fixtureRecord.replace('## Freedoms', '## Modules\n- all: R1, R2; laws: stopped_*, active_*\n\n## Freedoms'), rec.clauses, modLawIds)[0].laws, modLawIds);
});

test('module state keeps shared blocks, only its own rules and laws, and never the Modules section', () => {
  const blocks = splitLaws(fixtureLaws);
  assert.equal(blocks.map(b => b.text).join('\n'), fixtureLaws);
  const [stopping, running] = modules(modRecord, modRec.clauses, modLawIds);
  const a = moduleState(modRecord, blocks, stopping);
  assert.match(a.record, /^R1: /m);
  assert.doesNotMatch(a.record, /^R2: /m);
  assert.doesNotMatch(a.record, /Modules|stopping:|running:/);
  assert.match(a.laws, /^law stopped_rejects:/m);
  assert.doesNotMatch(a.laws, /^law active_allows:/m);
  assert.match(a.laws, /^def allowed\(/m);
  assert.match(a.laws, /^type State is Data:/m);
  const b = moduleState(modRecord, blocks, running);
  assert.match(b.laws, /^law active_allows:/m);
  assert.doesNotMatch(b.laws, /^law stopped_rejects:/m);
  assert.match(b.record, /^R2: /m);
  assert.throws(() => splitLaws('  law indented:\n    x'), /column-zero|empty/);
});

test('modular receipt: each module is judged on its own slice, schema 2 verifies and fails closed', async () => {
  const requests = [];
  const receipt = await produce(modRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => { requests.push(r); return modFake(r); });
  assert.equal(receipt.schema, 2);
  assert.equal(receipt.verdict, 'pass');
  assert.equal(requests.length, 4);
  assert.deepEqual(Object.keys(requests[0].questions), ['R1']);
  assert.deepEqual(Object.keys(requests[0].questions.R1.criteria).sort(), ['none', 'stopped_rejects']);
  assert.doesNotMatch(requests[0].state.laws, /^law active_allows:/m);
  assert.doesNotMatch(requests[2].state.laws, /^law stopped_rejects:/m);
  assert.ok(requests.every(r => Buffer.byteLength(r.state.record) < Buffer.byteLength(modRecord)));
  verifyReceipt(receipt, modRec, fixtureLaws, modRecord);
  // Downgrade and mismatches are refused.
  assert.throws(() => verifyReceipt(stored, modRec, fixtureLaws, modRecord), /declares modules but the receipt is schema 1/);
  assert.throws(() => verifyReceipt(receipt, rec, fixtureLaws, fixtureRecord), /schema 2 but the record declares no modules/);
  assert.throws(() => verifyReceipt(receipt, modRec, fixtureLaws + '\n# edit', modRecord), /hashes are stale/);
  // Hand edits, even resealed, are caught by recomputation.
  assert.throws(() => verifyReceipt({ ...receipt, verdict: 'reject' }, modRec, fixtureLaws, modRecord), /hand-edited/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.answers.fidelity.stopped_rejects.noul = 0.1; return b; }), modRec, fixtureLaws, modRecord), /verdict does not match|policy rejects/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.stateSha256 = '0'.repeat(64); return b; }), modRec, fixtureLaws, modRecord), /state is stale/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { delete b.modules.running; return b; }), modRec, fixtureLaws, modRecord), /modules do not match/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.questions.coverage.R1.instructions += ' x'; return b; }), modRec, fixtureLaws, modRecord), /questions are stale/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.extra = 1; return b; }), modRec, fixtureLaws, modRecord), /unexpected format/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.__proto__x = 1; b.surprise = 1; return b; }), modRec, fixtureLaws, modRecord), /unexpected format/);
  // One failing module rejects the whole receipt.
  const failing = await produce(modRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => { const x = await modFake(r); if (r.questions.active_allows) x.answers.active_allows.noul = 0.5; return x; });
  assert.equal(failing.verdict, 'reject');
  assert.equal(failing.modules.running.verdict, 'reject');
  assert.equal(failing.modules.stopping.verdict, 'pass');
  assert.throws(() => verifyReceipt(failing, modRec, fixtureLaws, modRecord), /rejects a module/);
  // The model must stay identical across modules.
  let n = 0;
  await assert.rejects(produce(modRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', async r => ({ ...await modFake(r), model: ++n > 2 ? 'fixture/other' : 'fixture/fake' })), /different model/);
});

test('modules make a model fit the token ceiling that the whole state exceeds', async () => {
  const pad = '\n  # ' + 'x'.repeat(40000);
  const blocks = splitLaws(fixtureLaws).map(b => b.id ? b.text + pad : b.text);
  const big = blocks.join('\n');
  const sizes = [];
  const evaluate = async r => { sizes.push(Buffer.byteLength(JSON.stringify(r))); return modFake(r); };
  // Whole state: about 81 KB, which is over the 32K-token budget at the default estimate.
  await assert.rejects(produce(fixtureRecord, big, '0001-transitions.md', 'fixture/fake', evaluate), /32K input tokens/);
  assert.equal(sizes.length, 0);
  const receipt = await produce(modRecord, big, '0001-transitions.md', 'fixture/fake', evaluate);
  assert.equal(receipt.verdict, 'pass');
  assert.equal(sizes.length, 4);
  assert.ok(Math.max(...sizes) < 50000, 'each module request is about half the whole state');
  verifyReceipt(receipt, modRec, big, modRecord);
});

test('every module is sized before any call, so a later oversized module spends nothing', async () => {
  const pad = '\n  # ' + 'x'.repeat(80000);
  const big = splitLaws(fixtureLaws).map(b => b.id === 'active_allows' ? b.text + pad : b.text).join('\n');
  let calls = 0;
  await assert.rejects(produce(modRecord, big, '0001-transitions.md', 'fixture/fake', async r => { calls++; return modFake(r); }), e => e.code === 1 && /32K input tokens/.test(e.message) && /worst-case fidelity question/.test(e.message));
  assert.equal(calls, 0);
});

test('modules: a multi-line rule is rejected, a bare "## " line cannot hide text, and section detection is linear', () => {
  const cont = fixtureRecord.replace(/^(R2: .*)$/m, '$1\n  Exception: an admin-initiated transition is always allowed.').replace('## Freedoms', '## Modules\n- stopping: R1; laws: stopped_rejects\n- running: R2; laws: active_allows\n\n## Freedoms');
  assert.ok(cont !== modRecord);
  // An intro line before R1 is allowed: it stays in every module's state.
  const intro = modRecord.replace(/^R1: /m, 'Each clause quotes the ontology verbatim.\n\nR1: ');
  assert.ok(intro !== modRecord);
  assert.equal(modules(intro, record(intro, '0001-transitions.md').clauses, modLawIds).length, 2);
  for (const m of modules(intro, record(intro, '0001-transitions.md').clauses, modLawIds)) assert.match(moduleState(intro, splitLaws(fixtureLaws), m).record, /quotes the ontology/);
  assert.throws(() => modules(cont, record(cont, '0001-transitions.md').clauses, modLawIds), /each rule must be one/);
  // Text after a bare "## " line is outside the Modules section for modules() and must reach every module's state.
  const hidden = modRecord.replace('## Freedoms', '## \nAll stopped sessions owned by admins may transition.\n\n## Freedoms');
  const mods = modules(hidden, record(hidden, '0001-transitions.md').clauses, modLawIds);
  for (const m of mods) assert.match(moduleState(hidden, splitLaws(fixtureLaws), m).record, /owned by admins/);
  const slow = modRecord.replace('## Freedoms', '## x' + ' '.repeat(120000) + 'y\n\n## Freedoms');
  const started = Date.now();
  for (const m of mods) moduleState(slow, splitLaws(fixtureLaws), m);
  assert.ok(Date.now() - started < 1000, 'section detection must not backtrack');
});

test('splitLaws gives a law its own doc comment, rejects a hidden law declaration, and a resealed module list is caught', async () => {
  const docs = fixtureLaws.replace(/^(law active_allows:)/m, '# Doc for active_allows\n$1');
  assert.ok(docs !== fixtureLaws);
  const [stopping, running] = modules(modRecord, modRec.clauses, modLawIds);
  assert.doesNotMatch(moduleState(modRecord, splitLaws(docs), stopping).laws, /Doc for active_allows/);
  assert.match(moduleState(modRecord, splitLaws(docs), running).laws, /# Doc for active_allows\nlaw active_allows:/);
  assert.equal(splitLaws(docs).map(b => b.text).join('\n'), docs);
  assert.throws(() => splitLaws(fixtureLaws + '\nlaw zz: true\n  note = """\nlaw ghost: true\n"""\n'), /column-zero|a string must stay on one line/);
  const receipt = await produce(modRecord, fixtureLaws, '0001-transitions.md', 'fixture/fake', modFake);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.laws = ['active_allows']; return b; }), modRec, fixtureLaws, modRecord), /clauses or laws changed/);
  assert.throws(() => verifyReceipt(reseal(receipt, b => { b.modules.stopping.clauses = ['R2']; return b; }), modRec, fixtureLaws, modRecord), /clauses or laws changed/);
});

test('the precheck also sizes coverage questions, so many long law ids in a later module spend nothing', async () => {
  const active = splitLaws(fixtureLaws).find(b => b.id === 'active_allows').text;
  const extra = Array.from({ length: 140 }, (_, i) => active.replace('active_allows', `zqq${i}_${'x'.repeat(230)}`)).join('\n');
  const laws = fixtureLaws + '\n' + extra + '\n';
  const rec = modRecord.replace('laws: active_allows', 'laws: active_allows, zqq*');
  let calls = 0;
  await assert.rejects(produce(rec, laws, '0001-transitions.md', 'fixture/fake', async r => { calls++; return modFake(r); }), e => e.code === 1 && /32K input tokens/.test(e.message));
  assert.equal(calls, 0);
});

test('modules: odd heading whitespace and non-LF line breaks cannot hide or move approved text', () => {
  const needle = 'Admins may always transition.';
  const clauses = () => record(modRecord, '0001-transitions.md').clauses;
  const reach = text => modules(text, record(text, '0001-transitions.md').clauses, modLawIds).map(m => moduleState(text, splitLaws(fixtureLaws), m).record.includes(needle));
  for (const h of ['##  Modules', '## \tModules']) assert.deepEqual(reach(modRecord.replace('## Freedoms', `${h}\n${needle}\n\n## Freedoms`)), [true, true]);
  const pseudo = modRecord.replace('## Freedoms', '##  Rules\nR9: ' + needle + '\nR2: Owners may always transition.\n\n## Freedoms');
  for (const present of reach(pseudo)) assert.equal(present, true);
  assert.equal(modules(pseudo, clauses(), modLawIds).length, 2);
  for (const br of ['\r', '\u2028', '\u2029']) {
    assert.throws(() => modules(modRecord.replace('\nR2: ', `${br}R2: `), clauses(), modLawIds), /line breaks must be LF or CRLF/);
    assert.throws(() => modules(modRecord.replace('\n## Freedoms', `${br}## Freedoms`), clauses(), modLawIds), /line breaks must be LF or CRLF/);
  }
  const crlf = modRecord.replaceAll('\n', '\r\n');
  assert.equal(modules(crlf, record(crlf, '0001-transitions.md').clauses, modLawIds).length, 2);
});

test('splitLaws: a declaration Bend would still see must start at column zero of an LF line, or the laws are rejected', () => {
  assert.ok(fixtureLaws.includes('\n\ndef canRun'), 'fixture layout changed');
  for (const [name, layout] of [['lone CR', '\r\rdef canRun'], ['indented', '\n\n  def canRun'], ['same line', ' def canRun'], ['indented type', '\n\n  type Extra is Data:\n    A{}\ndef canRun'], ['indented import', '\n  import Base as B\ndef canRun']]) {
    const text = fixtureLaws.replace('\n\ndef canRun', layout);
    assert.notEqual(text, fixtureLaws);
    assert.throws(() => splitLaws(text), /LAWS\.bend: unsupported layout at line \d+/, name);
  }
  assert.throws(() => splitLaws(fixtureLaws.replace('\n\ndef canRun', '} def canRun')), /second declaration|line breaks/);
  assert.throws(() => splitLaws(fixtureLaws.replace('Finite decision', 'Finite\rdecision')), /lone CR/);
  assert.doesNotThrow(() => splitLaws(fixtureLaws.replaceAll('\n', '\r\n')));
  assert.doesNotThrow(() => splitLaws(fixtureLaws + '\n# def inside a comment and "type in a string"\n'));
});

test('modules: parser disagreement is rejected directly, and each odd rule or heading is refused for its own reason', () => {
  const all = record(modRecord, '0001-transitions.md').clauses;
  assert.throws(() => modules(modRecord, all.slice(0, 1), modLawIds), /parser disagreement on the rules/);
  assert.throws(() => modules(modRecord, [...all, { id: 'R3', text: 'Extra clause.' }], modLawIds), /parser disagreement on the rules/);
  // Each of these must fail for the stated reason, not through the agreement backstop.
  for (const odd of ['R3:x', 'R3: ', 'R3:\tTabbed text.', '##\tNote', '##\u00a0Note']) {
    assert.throws(() => modules(modRecord.replace('\nR2: ', `\n${odd}\nR2: `), all, modLawIds), /each rule must be one/, JSON.stringify(odd));
  }
  // A bare '## ' ends the Rules section for both parsers, so R2 stops being a rule and only the agreement check sees it.
  assert.throws(() => modules(modRecord.replace('\nR2: ', '\n## \nR2: '), all, modLawIds), /parser disagreement on the rules/);
  for (const tail of [' ', '\t', '\u00a0', ' \t ']) assert.equal(modules(modRecord.replace('## Modules\n', `## Modules${tail}\n`), all, modLawIds).length, 2, JSON.stringify(tail));
  // The Modules heading may be the last section, with no trailing newline.
  const last = modRecord.replace('\n\n## Freedoms', '\n\n## Freedoms').split('## Modules')[0] + '## Modules\n- stopping: R1; laws: stopped_rejects\n- running: R2; laws: active_allows';
  assert.equal(modules(last, all, modLawIds).length, 2);
});

test('property: every line outside the Modules section reaches exactly the right module states, whatever is fuzzed in', () => {
  const sites = modRecord.split('\n');
  const fuzz = ['\u0085', '\v', '\f', '\u00a0', '\r', '\u2028', '\u2029', ' ', '\t', '\u3000', '\ufeff'];
  const variants = [modRecord];
  for (const ch of fuzz) {
    for (let i = 0; i < sites.length; i++) {
      for (const where of ['start', 'end', 'break', 'afterHashes']) {
        const next = [...sites];
        if (where === 'start') next[i] = ch + next[i];
        else if (where === 'end') next[i] = next[i] + ch;
        else if (where === 'afterHashes') { if (!next[i].startsWith('## ')) continue; next[i] = '##' + ch + next[i].slice(2); }
        else { variants.push(sites.slice(0, i).join('\n') + ch + sites.slice(i).join('\n')); continue; }
        variants.push(next.join('\n'));
      }
    }
  }
  // Decoy headings that the parser ignores or accepts: text under them must still be accounted for.
  for (const h of ['##  Modules', '## \tModules', '##  Rules', '## \u00a0Rules', '## Modules ', '## Rules\u00a0', '## rules', '##Modules']) {
    for (let i = 1; i < sites.length; i++) variants.push([...sites.slice(0, i), h, 'R2: Decoy text that must not vanish.', 'Free text that must not vanish.', ...sites.slice(i)].join('\n'));
  }
  // Seeded random insertions and deletions at arbitrary offsets, so the sites are not only the ones chosen above.
  let seed = 20260610;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const tokens = [...fuzz, '\n', '\r\n', '## ', '## Rules', '## Modules', '##', 'R1: ', 'R2: ', 'R3: ', 'R3:', '\nR3: Extra.\n', '```\n', '- extra: R1; laws: x\n'];
  for (let k = 0; k < 4000; k++) {
    let text = modRecord;
    for (let edits = 1 + rnd(3); edits > 0; edits--) {
      const at = rnd(text.length + 1);
      text = rnd(4) === 0 ? text.slice(0, at) + text.slice(at + 1 + rnd(8)) : text.slice(0, at) + tokens[rnd(tokens.length)] + text.slice(at);
    }
    variants.push(text);
  }
  let accepted = 0, rejected = 0;
  for (const text of variants) {
    let mods, parsed;
    try { parsed = record(text, '0001-transitions.md').clauses; mods = modules(text, parsed, modLawIds); } catch { rejected++; continue; }
    if (!mods) continue;
    accepted++;
    // Independent oracle: sections located with the record parser's own regexes, rule lines taken from its clauses, nothing from recordSpans.
    const region = name => {
      const m = new RegExp(`^## ${name}\\s*$`, 'm').exec(text);
      if (!m) return [Infinity, Infinity];
      const from = m.index, rest = text.slice(from + m[0].length), next = /^## /m.exec(rest);
      return [from, next ? from + m[0].length + next.index : text.length];
    };
    const [modFrom, modTo] = region('Modules'), [ruleFrom, ruleTo] = region('Rules');
    const owner = new Map(mods.flatMap(m => m.clauses.map(c => [c.id, m.name])));
    const ruleLines = new Map(parsed.map(c => [`${c.id}: ${c.text}`, c.id]));
    let offset = 0;
    const placed = text.split('\n').map(raw => {
      const at = offset; offset += raw.length + 1;
      const bare = raw.replace(/\r$/, '');
      const inModules = at >= modFrom && at < modTo;
      const rule = !inModules && at > ruleFrom && at < ruleTo ? ruleLines.get(bare) : undefined;
      return { raw, inModules, owner: rule ? owner.get(rule) : undefined };
    });
    assert.equal(placed.filter(p => p.owner).length, parsed.length, 'every parsed clause is one rule line');
    for (const m of mods) {
      const expected = placed.filter(p => !p.inModules && (p.owner === undefined || p.owner === m.name)).map(p => p.raw).join('\n');
      assert.equal(moduleState(text, splitLaws(fixtureLaws), m).record, expected, 'module ' + m.name);
    }
  }
  assert.ok(accepted > 500 && rejected > 500, 'fuzz should exercise both paths: ' + accepted + '/' + rejected);
});

test('scanner: ordinary literals pass; every layout it cannot read is refused as unsupported layout at line N', () => {
  assert.equal(codeOnly("x '#' y # c\n'\"' \"a'b\" '\\n' '\\'' '\\u{41}' 1.5 3n 0x1F 1.5e-2 'é' '😀' x1 a.b"), "x '_' y \n'_' \"\" '_' '_' '_' 1.5 3n 0x1F 1.5e-2 '_' '_' x1 a.b");
  assert.equal(codeOnly('x "a\\"b def" y'), 'x "" y', 'an escaped quote stays inside the string');
  assert.equal(codeOnly('a "x\ny" b'), 'a ""\n b', 'a string keeps its line count so line numbers stay true');
  const bad = ["'''", "''", "'ab'", "'\n'", "'\t'", "'\\x41'", "x'", "f'", "'", '1.5law', '1.0law', '1.5e2law', '5def', '0law', '1.5type', '"a"law', "'a'law", 'x"a"', '"open', '"a\\\nb"', '\u00a0', '\u2028', '\u000c', "'a", "'\r'", "'\\q'"];
  for (const piece of bad) {
    const source = 'law a:\n  ' + piece + '\n';
    assert.throws(() => codeOnly(source), /LAWS\.bend: unsupported layout at line [12]: /, JSON.stringify(piece));
    assert.throws(() => lawIds(source + '\n'), IntentError, JSON.stringify(piece));
  }
  assert.throws(() => codeOnly('law a:\n\n  1.5law b:\n'), /unsupported layout at line 3: a number touches a word/);
  assert.throws(() => codeOnly("x\n'''", 'neg/n.bend'), /^IntentError: neg\/n\.bend: unsupported layout at line 2|neg\/n\.bend: unsupported layout at line 2/);
  assert.throws(() => codeOnly('# a\rb\n'), /lone CR/);
  assert.throws(() => codeOnly('a\rb\n'), /lone CR/);
  assert.throws(() => codeOnly("x '"), IntentError);
  assert.throws(() => splitLaws(fixtureLaws.replace('Finite decision', 'Finite\rdecision')), /lone CR/);
  assert.doesNotThrow(() => codeOnly('# fine \u00a0 in a comment\n"and\u00a0in a string"\n'));
});

test('without modules the same layout rules apply: a law Bend checks cannot hide from lawIds, the check or the gate', () => {
  const claim = "\n  {'a' == 'a' : Char}\ndef hidden(): {==}\n";
  for (const hider of ["def b() -> Char: 'x' law hidden:", '(1)law hidden:', '1 law hidden:', 'def b() -> Nat: 1 law hidden:', '  law hidden:', '\tlaw hidden:']) {
    assert.throws(() => lawIds(fixtureLaws + '\n' + hider + claim), IntentError, hider);
  }
  assert.deepEqual(lawIds(fixtureLaws), lawIds(fixtureLaws + '\n# law ghost: def x\n'));
  // @ is Bend's decorator only as @unsafe above a def; elsewhere it is a binder inside a body and must stay with its law.
  const binder = "law m2:\n  {'a' == 'a' : Char}\n\nlaw m1:\n@x\n  : Char -> {'a' == 'a' : Char}\n";
  assert.throws(() => lawIds(binder), /unsupported layout at line 5: "@x"/);
  assert.throws(() => splitLaws(binder), /unsupported layout/);
  const head = 'law a:\n  {1n == 1n : Nat}\n';
  assert.throws(() => lawIds(head + '@unsafe\n'), /unsupported layout at line 3/);
  assert.throws(() => lawIds(head + '@unsafe\nlaw b:\n  {1n == 1n : Nat}\n'), /unsupported layout at line 3/);
  assert.throws(() => lawIds(head + '@unsafe law b:\n'), /second declaration/);
  assert.throws(() => lawIds(head + '@x\ndef f() -> Nat:\n  1n\n'), /unsupported layout at line 3/);
  assert.throws(() => lawIds(head + '@unsafe\ndefx() -> Nat:\n  1n\n'), /unsupported layout at line 3/);
  assert.doesNotThrow(() => lawIds(head + '@unsafe\n# note\n\ndef f() -> Nat:\n  1n\n'));
  assert.throws(() => splitLaws(fixtureLaws + '\nlaw a2\n  : x\n'), IntentError);
  assert.doesNotThrow(() => codeOnly("x '\u00a0' '\u3000' '\ufeff'"));
  assert.throws(() => codeOnly("x 'a'1"), /touches a word/);
  assert.throws(() => codeOnly('x 1.y'), /touches a word/);
  assert.throws(() => codeOnly('x \uFEFF y'), /Unicode space/);
  assert.throws(() => codeOnly("x '\\x'"), /unknown escape/);
  assert.doesNotThrow(() => codeOnly("x '\\u{00000041}'"));
  assert.throws(() => codeOnly("x '\\u{000000041}'"), /unknown escape/);
});

test('gate: spaced ?TODO and @ unsafe forms are forbidden like the plain ones', () => {
  assert.ok(text(join(root, 'kit/intent-gate.mjs')).includes('FORBIDDEN_BEND.test(text)'), 'the gate applies the shared pattern to every authored file');
  const forbidden = FORBIDDEN_BEND;
  for (const bad of ['? TODO', '?\nTODO', '?\tTODO', '@ unsafe def f', '@unsafe def f', '?TODO', 'def safe() -> Nat: 1n def evil?() -> Nat: 1n']) assert.ok(forbidden.test(codeOnly('def f() -> Nat:\n  ' + bad + '\n')), JSON.stringify(bad));
  assert.equal(forbidden.test(codeOnly('def f() -> Nat:\n  1n # ? TODO @unsafe\n')), false);
});

test('splitLaws: the accepted layout is column-zero declarations only; anything else is refused with its line number', () => {
  const base = fixtureLaws.replace('\n\ndef canRun', '\n\nlaw hash_ok:\n  {\'#\' == \'#\' : Char}%DEF\n\ndef canRun');
  assert.ok(base.includes('%DEF'));
  // F1/F3: after a literal or a number, a real declaration on the same line is a second declaration, never hidden.
  for (const hider of [" def canRun2(x: State) -> Bool:", " law hidden:", " type Extra is Data:", " import Base as B"]) {
    assert.throws(() => splitLaws(base.replace('%DEF', hider)), /unsupported layout at line \d+: .*second declaration/, hider);
  }
  assert.throws(() => splitLaws(fixtureLaws + "\ndef q() -> Char: ''' law hid: {'a' == 'a' : Char}\n"), /unsupported layout at line \d+: a single quote/);
  assert.throws(() => splitLaws(fixtureLaws + "\ndef q() -> Char:\n  '\n' law hid: {'a' == 'a' : Char}\n"), /unsupported layout at line \d+: a single quote/);
  assert.throws(() => splitLaws(fixtureLaws + '\ndef k() -> F32: 1.5law hid: {1n == 1n : Nat}\n'), /unsupported layout at line \d+: a number touches a word/);
  assert.throws(() => splitLaws(fixtureLaws + "\ndef k() -> Char: '#' law hid: {'a' == 'a' : Char}\n"), /second declaration/);
  assert.throws(() => splitLaws(fixtureLaws + '\ndef k() -> String: "a # b" law hid: {1n == 1n : Nat}\n'), /second declaration/);
  assert.throws(() => splitLaws(fixtureLaws + '\ndef k() -> Nat: 1n law\r\n'), /second declaration/);
  assert.throws(() => splitLaws(fixtureLaws + '\n\tlaw x:\n'), /not a column-zero declaration/);
  assert.throws(() => splitLaws(fixtureLaws + '\n  def\n'), /column-zero/);
  assert.throws(() => splitLaws(fixtureLaws + '\n@unsafe def f() -> Nat:\n  1n\n'), /second declaration/);
  // F4: a body at column zero would be split off as a shared block, so it is refused.
  const line = fixtureLaws.split('\n').length + 2;
  assert.throws(() => splitLaws(fixtureLaws + "\nlaw b2:\nfor x: Nat\n{Nat.add(x, 0n) == x : Nat}\n"), new RegExp('unsupported layout at line ' + line + ': "for x: Nat" is column-zero text'));
  assert.throws(() => splitLaws(fixtureLaws + '\ndef g() -> U32:\n0\n'), /column-zero text that is not a declaration/);
  assert.throws(() => splitLaws(fixtureLaws + '\nλ\n'), /column-zero text/);
  assert.throws(() => splitLaws(fixtureLaws + '\nlawful x\n'), /column-zero text/);
  const attr = splitLaws('law a:\n  {1n == 1n : Nat}\n@unsafe\ndef f() -> Nat:\n  1n\n');
  assert.deepEqual(attr.map(b => b.id), ['a', null, null]);
  assert.equal(attr[1].text, '@unsafe');
  assert.throws(() => splitLaws(fixtureLaws + '\ndef s() -> String:\n  "a\nb"\n'), /unsupported layout at line \d+: a string must stay on one line/);
  assert.doesNotThrow(() => splitLaws(fixtureLaws + '\n@unsafe\ndef g() -> Nat:\n  1n\n'));
  assert.doesNotThrow(() => splitLaws(fixtureLaws + '\ndef g(a: Nat) -> Nat:\n  a.law b\n'));
  // The backstop: a law whose id sits on a continuation line is seen by lawIds but is not a block of its own.
  assert.throws(() => splitLaws(fixtureLaws + "\nlaw\n  hid:\n  {'a' == 'a' : Char}\n"), /not a column-zero `law <id>:` block/);
  assert.deepEqual(lawIds('law a :\n  {1n == 1n : Nat}\n'), ['a']);
  assert.equal(splitLaws('law a :\n  {1n == 1n : Nat}\n')[0].id, 'a');
  // A header comment with no declaration below it stays its own block; a doc comment goes with its declaration.
  const header = splitLaws('# Header comment\nlaw a:\n  {1n == 1n : Nat}\n\nlaw b:\n  {2n == 2n : Nat}\n');
  assert.deepEqual(header.map(b => b.id), [null, 'a', 'b']);
  assert.equal(header[0].text, '# Header comment');
  const docs = splitLaws('law a:\n  {1n == 1n : Nat}\n# doc for b\nlaw b:\n  {2n == 2n : Nat}\n');
  assert.equal(docs[1].text, '# doc for b\nlaw b:\n  {2n == 2n : Nat}\n');  assert.equal(splitLaws(fixtureLaws).map(b => b.text).join('\n'), fixtureLaws);
});

// Property test by construction: the file is built from known pieces, so what must be refused and what each declaration is comes from
// how the file was made, never from reading it back. Valid pieces must always be accepted; any invalid piece, second declaration on a
// line, indented declaration or stray column-zero line must always be refused.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const VALID = ["'a'", "'#'", "'\"'", "'\\''", "'\\n'", "'\\\\'", "'\\u{41}'", '"s"', '"a # b"', '"it\'s"', '"q\\"law x:"', '"def d: type t"', '1.5', '42', '3n', '1.5e-2', '0x1F', 'x1', 'a.b', 'λ'];
const INVALID = ["'''", "''", "'ab'", "'\t'", "'\\x41'", '1.5law', '5def', "x'", '"open', "'", '\u00a0', "'\n'", '"a\\\nb"'];
test('property: valid layouts are always accepted and every unsupported one refused, over built files', () => {
  const rand = mulberry32(20261005);
  const pick = list => list[Math.floor(rand() * list.length)];
  let accepted = 0, refused = 0;
  for (let n = 0; n < 600; n++) {
    const lines = rand() < 0.3 ? ['# header law h: def d'] : [];
    const expectIds = [];
    let refuse = false;
    for (let d = 0, count = 1 + Math.floor(rand() * 5); d < count; d++) {
      const kind = pick(['law', 'law', 'def', 'type', 'import']);
      const id = 'L' + d;
      if (kind === 'law') { expectIds.push(id); lines.push('law ' + id + ':', "  {'a' == 'a' : Char}"); }
      else if (kind === 'def') lines.push('def f' + d + '() -> Nat:', '  1n');
      else if (kind === 'type') lines.push('type T' + d + ' is Data:', '  A{}');
      else lines.push('import Base as B' + d);
      for (let k = Math.floor(rand() * 3); k > 0; k--) {
        const tokens = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(VALID));
        const roll = rand();
        let tail = '';
        if (roll < 0.1) { tokens.push(pick(INVALID)); refuse = true; }
        else if (roll < 0.2) { tokens.push('law hid' + d + ': {1n == 1n : Nat}'); refuse = true; }
        else if (roll < 0.25) { tokens.push(pick(['def', 'type', 'import', 'law']) + ' z'); refuse = true; }
        else if (roll < 0.35) tail = ' # ' + pick(['law c: def d', "'", '"', 'x']);
        lines.push('  ' + tokens.join(' ') + tail);
        if (rand() < 0.05) { lines.push(pick(['  law ind' + d + ':', '\tdef t:', '  type I is Data:'])); refuse = true; }
        if (rand() < 0.05) { lines.push(pick(['x', '{', '1n', 'for x: Nat', '@@'])); refuse = true; }
      }
      if (rand() < 0.3) lines.push('');
    }
    if (!expectIds.length) { lines.push('law LX:', "  {'a' == 'a' : Char}"); expectIds.push('LX'); }
    const source = lines.join('\n') + '\n';
    if (refuse) {
      refused++;
      assert.throws(() => splitLaws(source), IntentError, 'must refuse: ' + JSON.stringify(source));
    } else {
      accepted++;
      const blocks = splitLaws(source);
      assert.equal(blocks.map(b => b.text).join('\n'), source, 'round trip: ' + JSON.stringify(source));
      assert.deepEqual(lawIds(source), expectIds, JSON.stringify(source));
      assert.deepEqual(blocks.filter(b => b.id).map(b => b.id), expectIds);
    }
  }
  assert.ok(accepted > 100 && refused > 100, 'the generator exercises both sides: ' + accepted + ' accepted, ' + refused + ' refused');
});

// The Bend-backed oracle: for files built from templates that Bend itself accepts, a law Bend sees is one whose false claim makes
// Bend fail at its name. Whenever the scanner accepts a file, its law ids must be exactly those Bend sees. Skipped when bend is not
// installed, so the offline gate stays offline.
const hasBend = spawnSync(bend, ['--help'], { encoding: 'utf8' }).status === 0;
test('Bend-backed oracle: a file the scanner accepts has exactly the laws Bend sees', { skip: !hasBend && 'bend is not installed' }, t => {
  const dir = mkdtempSync(join(root, '.scratch/bend-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rand = mulberry32(35);
  const law = (name, broken) => 'law ' + name + ': {\'a\' == \'' + (broken === name ? 'b' : 'a') + '\' : Char}';
  const plain = (name, broken) => [law(name, broken).replace(': ', ':\n  '), '', 'def ' + name + '(): {==}'];
  const SAFE = [
    n => ['# law ghost: \' " def x', 'def c' + n + "() -> Char: '#'"],
    n => ['def c' + n + "() -> Char: '\"'"],
    n => ['def c' + n + "() -> Char: '\\''"],
    n => ['def s' + n + '() -> String: "a # law ghost: \' b"'],
    n => ['def f' + n + '() -> F32: 1.5'],
  ];
  const HIDERS = [
    (n, b) => ['def h' + n + "() -> Char: ''' " + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + '() -> Char:', "  '", "' " + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + '() -> F32: 1.5' + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + "() -> Char: '#' " + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + '() -> String: "a" ' + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => [law('hid' + n, b).replace(': ', ':\n'), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + "() -> Char: 'x' " + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['def h' + n + '() -> F32: 1.5 ' + law('hid' + n, b), 'def hid' + n + '(): {==}'],
    (n, b) => ['  ' + law('hid' + n, b), 'def hid' + n + '(): {==}'],
  ];
  const seen = (file, names) => names.filter(name => {
    const out = spawnSync(bend, [file, '--check-only'], { encoding: 'utf8', env });
    return out.status !== 0 && new RegExp('^Location: ' + name + '$', 'm').test(out.stdout + out.stderr);
  });
  let accepted = 0, refusedWithHidden = 0;
  for (let n = 0; n < 24; n++) {
    const names = [];
    const plan = [];
    for (let k = 0, count = 1 + Math.floor(rand() * 3); k < count; k++) {
      const roll = rand();
      plan.push(roll < 0.4 ? { plain: true } : roll < 0.65 ? { safe: Math.floor(rand() * SAFE.length) } : { hider: Math.floor(rand() * HIDERS.length) });
    }
    plan.push({ plain: true });
    const build = broken => plan.flatMap((p, k) => {
      if (p.plain) { if (!names.includes('L' + k)) names.push('L' + k); return [...plain('L' + k, broken), '']; }
      if (p.safe !== undefined) return [...SAFE[p.safe](k), ''];
      if (!names.includes('hid' + k)) names.push('hid' + k);
      return [...HIDERS[p.hider](k, broken), ''];
    }).join('\n');
    const baseline = 'import Base\n\n' + build(null);
    const file = join(dir, 'f' + n + '.bend');
    writeFileSync(file, baseline);
    const ok = spawnSync(bend, [file, '--check-only'], { encoding: 'utf8', env });
    assert.equal(ok.status, 0, 'the template itself must be valid Bend: ' + baseline + ok.stdout + ok.stderr);
    let ids = null;
    try { ids = lawIds(baseline); } catch { /* refused: nothing to compare */ }
    const sees = names.filter(name => {
      writeFileSync(file, 'import Base\n\n' + build(name));
      return seen(file, [name]).length === 1;
    });
    if (ids) { accepted++; assert.deepEqual(ids, sees, 'scanner and Bend agree on:\n' + baseline); }
    else if (sees.some(name => name.startsWith('hid'))) refusedWithHidden++;
  }
  assert.ok(accepted >= 3, 'some files are accepted: ' + accepted);
  assert.ok(refusedWithHidden >= 3, 'files with a Bend-visible hidden law were refused: ' + refusedWithHidden);
});
