// Shared offline policy and bounded process runner. No third-party dependencies.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY = Object.freeze({ version: 'pi-intent/1', coverageThreshold: 0.8, fidelityThreshold: 0.9 });
export class IntentError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
export const reject = (message) => { throw new IntentError(message); };
export const unavailable = (message) => { throw new IntentError(message, 2); };
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export function read(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { unavailable(`input unavailable: ${path}: ${error.message}; restore the file or run pi-intent init`); }
}
export function json(path) {
  try { return JSON.parse(read(path)); }
  catch (error) { if (error instanceof IntentError) throw error; unavailable(`${path}: invalid JSON; fix its syntax`); }
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function seal(receipt) { return { ...receipt, integrity: sha256(canonical(receipt)) }; }
export function codeOnly(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|#[^\n]*/g, match => match.startsWith('#') ? '' : '""');
}
// Resolve authored proof defs to the file owning their law, rather than trusting
// a same-name def in an unrelated module. Bend checks the judgment afterwards.
export function hasProof(lawFile, law, sourceFile, text) {
  const code = codeOnly(text);
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (resolve(lawFile) === resolve(sourceFile) && new RegExp(`^def\\s+${escape(law)}\\s*\\(`, 'm').test(code)) return true;
  for (const m of code.matchAll(/^import\s+(\.\.?\/\S+?)(?:\.bend)?\s+as\s+([A-Za-z_]\w*)\s*$/gm)) {
    const imported = m[1].endsWith('.bend') ? m[1] : `${m[1]}.bend`;
    if (resolve(dirname(sourceFile), imported) === resolve(lawFile) && new RegExp(`^def\\s+${escape(m[2])}\\.${escape(law)}\\s*\\(`, 'm').test(code)) return true;
  }
  return false;
}
export function lawIds(text) {
  const ids = [...codeOnly(text).matchAll(/^law\s+([A-Za-z_][\w.]*)\s*:/gm)].map(m => m[1]);
  if (!ids.length || new Set(ids).size !== ids.length || ids.includes('none')) reject('LAWS.bend: empty, duplicate or reserved law ids; declare unique laws (none is reserved for receipt coverage)');
  return ids;
}
export function record(text, filename) {
  const id = /^id: (\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*)$/m.exec(text)?.[1];
  const status = /^status: (descriptive|draft|approved)$/m.exec(text)?.[1];
  if (['id', 'status', 'context'].some(key => [...text.matchAll(new RegExp(`^${key}:`, 'gm'))].length !== 1)) reject(`${filename}: duplicate or missing metadata; keep one id, status and context line`);
  if (!id || `${id}.md` !== basename(filename) || !status) reject(`${filename}: invalid id or status; use the intent-record template`);
  const required = ['Intent', 'Vocabulary', 'Rules', 'Worked examples', 'Freedoms', 'Non-goals', 'Open questions', 'Approval'];
  for (const section of required) {
    const parts = text.split(new RegExp(`^## ${section}\\s*$`, 'm'));
    if (parts.length !== 2 || !parts[1].split(/^## /m)[0].trim()) reject(`${filename}: missing, empty or duplicate ${section}; restore that section`);
  }
  if (!/^context: .+CONTEXT\.md$/m.test(text)) reject(`${filename}: missing CONTEXT.md citation; cite the project's vocabulary`);
  const rules = text.split(/^## Rules\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const clauses = [...rules.matchAll(/^R([1-9]\d*): (.+)$/gm)].map(m => ({ id: `R${m[1]}`, text: m[2] }));
  if (!clauses.length || clauses.some((c, i) => c.id !== `R${i + 1}`)) reject(`${filename}: rules must be unique contiguous R1, R2, ...; renumber the clauses`);
  if (status === 'approved' && !/^approved-by: \S.*$/m.test(text.split(/^## Approval\s*$/m)[1] ?? '')) reject(`${filename}: missing human approval; record the approver after review`);
  return { id, status, clauses };
}
export function coverageQuestions(clauses, laws) {
  return Object.fromEntries(clauses.map(c => [c.id, {
    type: 'choice', instructions: `Which law encodes clause ${c.id}: ${c.text}? Choose none if no law faithfully covers it.`,
    criteria: Object.fromEntries([...laws.map(l => [l, `Law ${l}`]), ['none', 'No law covers this clause']]),
  }]));
}
export function fidelityQuestions(clauses, laws, answers) {
  return Object.fromEntries(laws.map(law => {
    const mapped = clauses.filter(c => answers[c.id]?.choice === law);
    return [law, { type: 'noul', instructions: `Does law ${law} faithfully encode clause(s) ${mapped.map(c => `${c.id}: ${c.text}`).join('; ') || 'none (answer false)'} without weakening, strengthening or adding unrelated constraints?`, criteria: { true: 'All mapped clauses are faithfully encoded and at least one is mapped.', false: 'No mapped clause, or a mismatch in meaning.' } }];
  }));
}
function probability(n) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1; }
export function verdict(clauses, laws, coverage, fidelity) {
  if (!coverage || !fidelity || Object.keys(coverage).sort().join() !== clauses.map(c => c.id).sort().join() || Object.keys(fidelity).sort().join() !== [...laws].sort().join()) reject('receipt: missing or extra judgments; regenerate with intent-receipt');
  let pass = true;
  for (const clause of clauses) {
    const a = coverage[clause.id];
    const keys = [...laws, 'none'].sort();
    if (a?.type !== 'choice' || !keys.includes(a.choice) || !probability(a.confidence) || !a.probabilities || Object.keys(a.probabilities).sort().join() !== keys.join() || !Object.values(a.probabilities).every(probability) || Math.abs(Object.values(a.probabilities).reduce((s, n) => s + n, 0) - 1) > 0.01) reject(`receipt: invalid Choice for ${clause.id}; regenerate with intent-receipt`);
    if (a.choice === 'none' || a.confidence < POLICY.coverageThreshold || a.probabilities[a.choice] < POLICY.coverageThreshold) pass = false;
  }
  for (const law of laws) {
    const a = fidelity[law];
    if (a?.type !== 'noul' || !probability(a.noul)) reject(`receipt: invalid Noul for ${law}; regenerate with intent-receipt`);
    if (a.noul < POLICY.fidelityThreshold || !clauses.some(c => coverage[c.id].choice === law)) pass = false;
  }
  return pass ? 'pass' : 'reject';
}
export function verifyReceipt(value, rec, lawsText, recordText) {
  const fields = ['schema', 'recordId', 'recordSha256', 'lawsSha256', 'policy', 'model', 'questions', 'answers', 'verdict', 'integrity'];
  if (!value || Object.keys(value).sort().join() !== fields.sort().join()) reject('receipt: unexpected format; regenerate with intent-receipt');
  const { integrity, ...body } = value;
  if (integrity !== sha256(canonical(body))) reject('receipt was hand-edited or corrupted; regenerate with intent-receipt, do not reseal it by hand');
  if (value.schema !== 1 || value.recordId !== rec.id || canonical(value.policy) !== canonical(POLICY) || typeof value.model !== 'string' || !value.model.trim()) reject('receipt: stale schema, identity, model or policy; regenerate with intent-receipt');
  if (value.recordSha256 !== sha256(recordText) || value.lawsSha256 !== sha256(lawsText)) reject('receipt hashes are stale for LAWS.bend or the record; get human approval then regenerate with intent-receipt');
  const laws = lawIds(lawsText);
  const questions = { coverage: coverageQuestions(rec.clauses, laws), fidelity: fidelityQuestions(rec.clauses, laws, value.answers?.coverage ?? {}) };
  if (canonical(value.questions) !== canonical(questions)) reject('receipt questions are stale or altered; regenerate with intent-receipt');
  const computed = verdict(rec.clauses, laws, value.answers?.coverage, value.answers?.fidelity);
  if (value.verdict !== computed || computed !== 'pass') reject('receipt policy rejects the recorded answers; revise laws with approval and regenerate with intent-receipt');
}
export function verifyHeaders(scriptUrl) {
  const dir = resolve(fileURLToPath(new URL('.', scriptUrl)));
  if (basename(dir) !== 'tools') return; // Package sources are versioned by npm/Git; vendored tools carry body hashes.
  // Only files owned by the kit: adopting apps may keep unrelated tools here.
  const scripts = ['gen-enums', 'intent-check', 'intent-conform', 'intent-core', 'intent-gate', 'intent-receipt', 'inventory'];
  let version;
  for (const name of scripts.map(name => `${name}.mjs`)) {
    const text = read(join(dir, name));
    const lines = text.split('\n');
    const index = lines[0].startsWith('#!') ? 1 : 0;
    const match = /^\/\/ pi-intent v(\S+) sha256=([a-f0-9]{64})$/.exec(lines[index]);
    lines.splice(index, 1);
    if (!match || sha256(lines.join('\n')) !== match[2] || (version && version !== match[1])) reject(`tools/${name}: stale or missing pi-intent header; re-run pi-intent vendor after reviewing local changes`);
    version = match[1];
  }
}
export function bendFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) reject(`${join(dir, e.name)}: symlink in model; use regular files`);
    if (e.name.startsWith('.')) return [];
    return e.isDirectory() ? bendFiles(join(dir, e.name)) : e.name.endsWith('.bend') ? [join(dir, e.name)] : [];
  });
}
export async function run(argv, cwd, timeoutMs = 30_000) {
  if (!Array.isArray(argv) || !argv.length || argv.some((a, i) => typeof a !== 'string' || (i === 0 && !a) || a.includes('\0'))) unavailable('command must be a nonempty argv array of strings; fix conform.json');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) unavailable('timeoutMs must be an integer from 1 to 600000; fix conform.json');
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout, stderr) => {
      if (error && (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code) || error.code === 'ENOBUFS' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.killed || error.signal)) {
        rejectPromise(new IntentError(`${argv[0]} unavailable, timed out or exceeded 1 MiB output: ${error.message}; install the tool or fix the command/limits`, 2));
      } else resolvePromise({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}
export function rootArg(argv, options = []) {
  let root = '.';
  let seen = false;
  for (const a of argv) {
    if (options.includes(a)) continue;
    if (a.startsWith('-') || seen) unavailable(`unknown argument ${a}; use [repo-dir] ${options.join(' ')}`);
    root = a; seen = true;
  }
  return resolve(root);
}
export async function cli(action, url) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url)) {
    try { await action(process.argv.slice(2)); }
    catch (error) { console.error(`pi-intent: ${error.message}`); process.exitCode = error instanceof IntentError ? error.code : 2; }
  }
}
export function isDirectory(path) { try { return statSync(path).isDirectory(); } catch { return false; } }
