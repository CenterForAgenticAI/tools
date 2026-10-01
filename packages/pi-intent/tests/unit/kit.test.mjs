import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { check } from '../../kit/intent-check.mjs';
import { conform } from '../../kit/intent-conform.mjs';
import { gate } from '../../kit/intent-gate.mjs';
import { liveEvaluator, produce } from '../../kit/intent-receipt.mjs';
import { canonical, codeOnly, hasProof, IntentError, lawIds, POLICY, record, rootArg, run, seal, sha256, verifyReceipt } from '../../kit/intent-core.mjs';
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj)); }
function command(script, dir, args = []) { return spawnSync(process.execPath, [join(root, script), dir, ...args], { encoding: 'utf8', env, timeout: 180000 }); }
function smallManifest(dir, overrides = {}) {
  const check = { name: 'small', laws: ['stopped_rejects', 'active_allows'], model: [process.execPath, '-e', 'console.log("a\\nb")'], real: [process.execPath, '-e', 'console.log("b\\na")'], broken: [process.execPath, '-e', 'console.log("wrong")'], ...overrides };
  writeJson(join(dir, 'intent/conform.json'), { schema: 1, checks: [check] });
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
  writeJson(join(dir, 'intent/receipts/0001-transitions.json'), receipt);
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
  const path = join(dir, 'intent/receipts/0001-transitions.json');
  writeJson(path, { ...stored, model: 'hand edited' });
  assert.throws(() => check(dir), /hand-edited/);
  writeJson(path, stored);
  writeFileSync(join(dir, 'intent/model/LAWS.bend'), fixtureLaws + '\n# changed');
  assert.throws(() => check(dir), /changed since approval/);
  writeFileSync(join(dir, 'intent/model/laws.sha256'), sha256(fixtureLaws + '\n# changed'));
  assert.throws(() => check(dir), /hashes are stale/);
  writeFileSync(join(dir, 'intent/model/LAWS.bend'), fixtureLaws);
  writeFileSync(join(dir, 'intent/model/laws.sha256'), sha256(fixtureLaws));
  writeFileSync(join(dir, 'intent/records/0001-transitions.md'), fixtureRecord + '\nchanged');
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
  writeFileSync(join(dir, 'intent/records/0001-transitions.md'), fixtureRecord.replace('status: approved', 'status: descriptive'));
  assert.throws(() => check(dir), /no approved/);
  rmSync(join(dir, 'intent/records/0001-transitions.md'));
  assert.throws(() => check(dir), /empty/);
  assert.equal(rootArg([]), root);
  assert.throws(() => rootArg(['--wrong']), /unknown/);
  assert.throws(() => rootArg(['a', 'b']), /unknown/);
  assert.throws(() => check(join(dir, 'missing')), e => e instanceof IntentError && e.code === 2);
});

test('vendor headers detect drift in check itself and shared scripts; init never approves', t => {
  const dir = fixture(t);
  vendor(dir);
  writeFileSync(join(dir, 'tools/unrelated.mjs'), '// app-owned tool, not vendored by pi-intent');
  const checked = spawnSync(process.execPath, [join(dir, 'tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(checked.status, 0, checked.stderr);
  for (const name of ['intent-check.mjs', 'intent-core.mjs']) {
    vendor(dir);
    writeFileSync(join(dir, 'tools', name), text(join(dir, 'tools', name)) + '\n// accidental drift');
    const result = spawnSync(process.execPath, [join(dir, 'tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /stale.*header/);
  }
  vendor(dir);
  const corePath = join(dir, 'tools/intent-core.mjs');
  writeFileSync(corePath, text(corePath).replace(`v${JSON.parse(text(join(root, 'package.json'))).version}`, 'v0.0.0'));
  assert.equal(spawnSync(process.execPath, [join(dir, 'tools/intent-check.mjs'), dir], { encoding: 'utf8', timeout: 30000 }).status, 1);
  const target = join(dir, 'new-app');
  init(target);
  assert.match(text(join(target, 'intent/records/0001-change.md')), /status: draft/);
  assert.equal(command('kit/intent-check.mjs', target).status, 1);
  assert.throws(() => init(target), /already exists/);
});

test('Bend gate proves laws and rejects both negatives and bypass constructs', async t => {
  const dir = fixture(t);
  await gate(dir, bend);
  for (const snippet of ['@unsafe', 'def bypass?(x):\n  x', '?TODO']) {
    writeFileSync(join(dir, 'intent/model/Bypass.bend'), snippet);
    await assert.rejects(gate(dir, bend), /forbidden/);
  }
  rmSync(join(dir, 'intent/model/Bypass.bend'));
  symlinkSync(join(dir, 'intent/model/LAWS.bend'), join(dir, 'intent/model/Alias.bend'));
  await assert.rejects(gate(dir, bend), /symlink/);
  rmSync(join(dir, 'intent/model/Alias.bend'));
  writeFileSync(join(dir, 'intent/model/neg/stopped.bend'), text(join(dir, 'intent/model/PROOF.bend')).replace('./LAWS.bend', '../LAWS.bend') + '\n# expect-failure: M.stopped_rejects');
  await assert.rejects(gate(dir, bend), /control did not fail/);
  writeFileSync(join(dir, 'intent/model/neg/stopped.bend'), 'import Missing\n# expect-failure: Missing\n');
  await assert.rejects(gate(dir, bend), /unrelated law/);
  writeFileSync(join(dir, 'intent/model/neg/stopped.bend'), 'import Base');
  await assert.rejects(gate(dir, bend), /missing # expect-failure/);
  rmSync(join(dir, 'intent/model/neg'), { recursive: true });
  await assert.rejects(gate(dir, bend), /empty/);
});

test('gate rejects orphaned laws, failed proofs and unavailable Bend', async t => {
  const dir = fixture(t);
  await assert.rejects(gate(dir, join(dir, 'no-bend')), e => e.code === 2);
  writeFileSync(join(dir, 'intent/model/Unimported.bend'), 'import Base\nlaw helper:\n  Unit\ndef helper():\n  False{}\n');
  await assert.rejects(gate(dir, bend), /Unimported.bend did not check/);
  rmSync(join(dir, 'intent/model/Unimported.bend'));
  writeFileSync(join(dir, 'intent/model/PROOF.bend'), 'import Base');
  await assert.rejects(gate(dir, bend), /no proof def/);
  writeFileSync(join(dir, 'intent/model/PROOF.bend'), text(join(example, 'intent/model/PROOF.bend')).replace('def M.stopped_rejects(to):\n  {==}', 'def M.stopped_rejects(to):\n  Unit{}'));
  await assert.rejects(gate(dir, bend), /did not check/);
});

for (const language of ['typescript', 'go', 'python', 'rust']) test(`${language} oracle executes app code, matches all 16 Bend cases and differs from broken model`, t => {
  if (language === 'rust' && spawnSync('cargo', ['--version'], { timeout: 5000 }).error) return t.skip('cargo is not on PATH; Rust conformance unavailable');
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, 'intent/conform.json')));
  manifest.checks = manifest.checks.filter(c => c.name === language);
  writeJson(join(dir, 'intent/conform.json'), manifest);
  const result = command('kit/intent-conform.mjs', dir, ['--require-coverage']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /16 cases; broken model differs/);
  assert.match(result.stdout, /uncovered laws: none/);
});

test('real implementation drift fails with disagreeing cases', t => {
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, 'intent/conform.json')));
  manifest.checks = manifest.checks.filter(c => c.name === 'typescript');
  writeJson(join(dir, 'intent/conform.json'), manifest);
  writeFileSync(join(dir, 'src/session.ts'), text(join(dir, 'src/session.ts')).replace("from !== 'not-running'", "from === 'not-running'"));
  const result = command('kit/intent-conform.mjs', dir);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /conformance drift/);
  assert.match(result.stderr, /idle->working true/);
});

test('a retyped oracle agrees with deliberately wrong model and is rejected', t => {
  const dir = fixture(t);
  const manifest = JSON.parse(text(join(dir, 'intent/conform.json')));
  const c = manifest.checks[0];
  // A wrong, retyped "real" oracle and model both claim every transition rejects.
  c.model = c.broken;
  c.real = [process.execPath, '-e', 'for(const f of ["idle","working","blocked","not-running"]) for(const t of ["idle","working","blocked","not-running"]) console.log(`${f}->${t} false`)'];
  manifest.checks = [c];
  writeJson(join(dir, 'intent/conform.json'), manifest);
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
  writeFileSync(join(dir, 'intent/conform.json'), '{');
  await assert.rejects(conform(dir), /invalid JSON/);
  writeJson(join(dir, 'intent/conform.json'), { schema: 1, checks: [] });
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
  writeFileSync(join(dir, 'intent/model/Flag.bend'), generate(spec));
  const result = await run([bend, 'Flag.bend', '--check-only'], join(dir, 'intent/model'), 120000);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, /ALL PROOFS CHECK/);
  const inv = inventory(join(dir, 'intent/model'));
  assert.ok(inv.declarations.some(d => d.id === 'stopped_rejects' && d.status === 'defined'));
  assert.ok(inv.counts.constructor > 0);
  assert.equal(hasProof('/a/L.bend', 'law', '/a/P.bend', 'import ./Other.bend as M\ndef M.law(x):'), false);
  assert.equal(hasProof('/a/L.bend', 'law', '/a/L.bend', 'def law(x):'), true);
  writeFileSync(join(dir, 'intent/model/PROOF.bend'), 'import ./Rows.bend as M\ndef M.stopped_rejects(to):\n  {==}\ndef M.active_allows(from,to):\n  {==}');
  assert.equal(inventory(join(dir, 'intent/model')).declarations.find(d => d.id === 'stopped_rejects').status, 'open');
  await assert.rejects(gate(dir, bend), /no proof def resolving/);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});
