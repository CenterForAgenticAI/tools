#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { INTENT_DIR, IntentError, cli, codeOnly, json, read, record, rootArg, run, sha256, splitLaws, unavailable, verifyHeaders } from './intent-core.mjs';

// Names everything a change to an approved record or LAWS.bend makes stale: the receipt itself, then clause -> law (the receipt as it was at the
// baseline) -> conformance row (conform.json, working tree) -> oracle (paths in the row's real command). It reads Git and files only; no Bend.
// Baseline: --since <ref> for everything, or by default each receipt's own recorded hashes against the files now, so an edit that is already
// committed (a shallow CI checkout) is still found; Git history only recovers the judged text to name clauses and laws. Exit 0: nothing stale. 1: something is stale or not yet checked. 2: a link is unreadable or malformed (bad ref, record, receipt, manifest).

const parsed = (label, fn) => {
  try { return fn(); } catch (error) {
    if (error instanceof IntentError) unavailable(`${label}: ${error.message}`);
    throw error;
  }
};

// The one place that knows the receipt's coverage shape (schema 1 answers.coverage; schema 2 modules[].answers.coverage): clause id -> law id or null.
export function clauseLaws(receipt, label) {
  const sets = receipt?.schema === 2 && receipt.modules && typeof receipt.modules === 'object' ? Object.values(receipt.modules).map(m => m?.answers?.coverage) : [receipt?.answers?.coverage];
  const map = new Map();
  for (const coverage of sets) {
    if (!coverage || typeof coverage !== 'object') unavailable(`${label}: receipt has no coverage answers; regenerate with intent-receipt`);
    for (const [clause, answer] of Object.entries(coverage)) {
      if (typeof answer?.choice !== 'string') unavailable(`${label}: receipt coverage for clause ${clause} has no choice; regenerate with intent-receipt`);
      map.set(clause, answer.choice === 'none' ? null : answer.choice);
    }
  }
  return map;
}

async function git(root, args) { return run(['git', '-C', root, ...args], root); }

async function snapshot(root, ref) {
  const commit = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (commit.status !== 0) unavailable(`${ref} does not name a commit in this Git repository; pass a valid ref with --since`);
  const listed = await git(root, ['ls-tree', '-r', '--name-only', ref, '--', `${INTENT_DIR}/`]);
  if (listed.status !== 0) unavailable(`cannot list ${INTENT_DIR}/ at ${ref}: ${listed.stderr.trim()}`);
  const files = new Set(listed.stdout.split('\n').filter(Boolean));
  return {
    files,
    async show(path) {
      if (!files.has(path)) return null;
      const out = await git(root, ['show', `${ref}:./${path}`]);
      if (out.status !== 0) unavailable(`cannot read ${path} at ${ref}: ${out.stderr.trim()}`);
      return out.stdout;
    },
  };
}

const lawBlocks = (text, label) => parsed(label, () => {
  const blocks = splitLaws(text);
  return { laws: new Map(blocks.filter(b => b.id).map(b => [b.id, b.text])), shared: codeOnly(blocks.filter(b => !b.id).map(b => b.text).join('\n'), 'LAWS.bend').replace(/\s+/g, ' ').trim() };
});
const topLevelRecords = files => [...files].filter(f => f.startsWith(`${INTENT_DIR}/records/`) && f.endsWith('.md')).map(f => f.slice(`${INTENT_DIR}/records/`.length)).filter(n => !n.includes('/'));

export async function impact(root, since = null) {
  const snaps = new Map();
  const snapOf = async ref => { if (!snaps.has(ref)) snaps.set(ref, await snapshot(root, ref)); return snaps.get(ref); };
  const sinceSnap = since ? await snapOf(since) : null;
  const base = since ?? 'the last receipt';
  const label = since ?? 'its receipt';
  const lines = [];
  const notYet = [];
  const notes = [];
  const events = new Map(); // law id -> { what: Set, why: string[] }
  const touch = (id, what, why) => {
    const e = events.get(id) ?? { what: new Set(), why: [] };
    if (what) e.what.add(what);
    if (why && !e.why.includes(why)) e.why.push(why);
    events.set(id, e);
  };

  // Laws: body changed, added or removed, and shared definitions (types, helpers, imports; comments ignored) changed.
  const lawsPath = `${INTENT_DIR}/model/LAWS.bend`;
  const nowText = read(join(root, lawsPath));
  const nowLaws = lawBlocks(nowText, lawsPath);
  const diffLaws = (thenText, where) => {
    const thenLaws = lawBlocks(thenText, `${lawsPath} at ${where}`);
    for (const [id, text] of nowLaws.laws) {
      if (!thenLaws.laws.has(id)) touch(id, 'was added');
      else if (thenLaws.laws.get(id) !== text) touch(id, 'changed');
    }
    for (const id of thenLaws.laws.keys()) if (!nowLaws.laws.has(id)) touch(id, 'was removed');
    if (thenLaws.shared !== nowLaws.shared) for (const id of [...nowLaws.laws.keys()].filter(id => thenLaws.laws.has(id))) touch(id, 'depends on changed shared definitions');
  };
  if (since) { const thenText = await sinceSnap.show(lawsPath); if (thenText !== null) diffLaws(thenText, since); }

  // Which records matter. A receipt is judged stale by the hashes it records against the files now, so no Git history decides it (a shallow CI
  // clone, a reformatted receipt or a receipt committed apart from its record cannot hide or invent staleness). History is read only to recover
  // the text the receipt judged, so that the clause -> law diff can be named; when it is unavailable the stale line stands without the detail.
  const recordsDir = join(root, INTENT_DIR, 'records');
  const receiptsDir = join(root, INTENT_DIR, 'receipts');
  const nowNames = existsSync(recordsDir) ? readdirSync(recordsDir).filter(n => n.endsWith('.md')) : [];
  const names = new Set(nowNames);
  if (since) for (const n of topLevelRecords(sinceSnap.files)) names.add(n);
  const nowIds = new Set();
  // Best effort: a Git failure (oversized historical blob, timeout) means the judged text is unavailable, never that the receipt is not stale.
  const lookup = async (path, hash) => {
    try {
      const log = await git(root, ['log', '--format=%H', '-n', '500', '--', path]);
      if (log.status !== 0) return null;
      for (const commit of log.stdout.split('\n').filter(Boolean)) {
        try {
          const out = await git(root, ['show', `${commit}:./${path}`]);
          if (out.status === 0 && sha256(out.stdout) === hash) return out.stdout;
        } catch (error) { if (!(error instanceof IntentError)) throw error; }
      }
    } catch (error) { if (!(error instanceof IntentError)) throw error; }
    return null;
  };
  for (const name of [...names].sort()) {
    const nowRaw = nowNames.includes(name) ? read(join(recordsDir, name)) : null;
    const now = nowRaw === null ? null : parsed(name, () => record(nowRaw, name));
    if (now) nowIds.add(now.id);
    const id = now?.id ?? name.slice(0, -3);
    let thenRaw; let thenLawsText; let receiptRaw; let staleRecord; let staleLaws; let then;
    if (since) {
      thenRaw = await sinceSnap.show(`${INTENT_DIR}/records/${name}`);
      then = thenRaw === null ? null : parsed(`${name} at ${since}`, () => record(thenRaw, name));
      if (now?.status === 'approved' && then?.status !== 'approved') notYet.push(`record ${name} is approved but had no approved record or receipt at ${since}: not yet checked`);
      if (then?.status !== 'approved') continue;
      receiptRaw = await sinceSnap.show(`${INTENT_DIR}/receipts/${then.id}.json`);
      if (receiptRaw === null) { notYet.push(`no receipt for approved record ${then.id} at ${since}: not yet checked`); continue; }
      thenLawsText = await sinceSnap.show(lawsPath);
      staleRecord = nowRaw !== thenRaw;
      staleLaws = now?.status === 'approved' && thenLawsText !== nowText;
    } else {
      if (now?.status !== 'approved') continue;
      const receiptPath = join(receiptsDir, `${now.id}.json`);
      if (!existsSync(receiptPath)) { notYet.push(`no receipt for approved record ${now.id}: not yet checked`); continue; }
      receiptRaw = read(receiptPath);
      const hashes = parsed(`receipt ${now.id}`, () => JSON.parse(receiptRaw));
      if (typeof hashes?.recordSha256 !== 'string' || typeof hashes?.lawsSha256 !== 'string') unavailable(`receipt ${now.id} records no recordSha256 or lawsSha256; regenerate with intent-receipt`);
      staleRecord = hashes?.recordSha256 !== sha256(nowRaw);
      staleLaws = hashes?.lawsSha256 !== sha256(nowText);
      thenRaw = staleRecord ? await lookup(`${INTENT_DIR}/records/${name}`, hashes?.recordSha256) : nowRaw;
      thenLawsText = staleLaws ? await lookup(lawsPath, hashes?.lawsSha256) : nowText;
      then = thenRaw === null ? null : parsed(`${name} as judged`, () => record(thenRaw, name));
      if (staleRecord && thenRaw === null) notes.push(`the record text receipt ${now.id} judged is not in the available Git history (shallow clone?): clause-to-law detail unavailable`);
      if (staleLaws && thenLawsText === null) notes.push(`the LAWS.bend receipt ${now.id} judged is not in the available Git history (shallow clone?): law, row and oracle detail unavailable for it`);
    }
    if (nowRaw === null) lines.push(`receipt ${id} is stale: record ${name} was removed since ${label}`);
    else if (staleRecord) lines.push(`receipt ${id} is stale: record ${name} changed since ${label}`);
    if (staleLaws) lines.push(`receipt ${id} is stale: LAWS.bend changed since ${label}`);
    if (!since && staleLaws && thenLawsText !== null) diffLaws(thenLawsText, `the text receipt ${id} judged`);
    if (!then) continue;
    const mapped = clauseLaws(parsed(`receipt ${id}`, () => JSON.parse(receiptRaw)), `receipt ${id}`);
    const nowClauses = new Map((now?.clauses ?? []).map(c => [c.id, c.text]));
    for (const clause of then.clauses) {
      const edited = !nowClauses.has(clause.id) ? 'removed' : nowClauses.get(clause.id) !== clause.text ? 'edited' : null;
      if (!edited) continue;
      const law = mapped.get(clause.id);
      if (law) touch(law, null, `clause ${clause.id} ${edited}`);
      else lines.push(`clause ${clause.id} ${edited}: the receipt maps it to no law; a law may now be needed`);
    }
    for (const cid of nowClauses.keys()) if (!then.clauses.some(c => c.id === cid)) lines.push(`clause ${cid} of ${then.id} is new: the receipt does not map it to a law`);
  }
  if (!since && existsSync(receiptsDir)) {
    for (const f of readdirSync(receiptsDir).filter(n => n.endsWith('.json')).sort()) {
      if (!nowIds.has(f.slice(0, -5))) notes.push(`receipt ${f} has no record in ${INTENT_DIR}/records; remove it if the record was retired`);
    }
  }

  const phrase = id => {
    const e = events.get(id);
    return `law ${id} ${e.what.size ? [...e.what].join(' and ') : 'is stale'}${e.why.length ? ` (${e.why.join('; ')})` : ''}`;
  };
  for (const id of events.keys()) lines.push(phrase(id));

  // Rows and oracles: conform.json as it is now, so a removed law that a row still names is reported rather than skipped.
  const manifestPath = join(root, INTENT_DIR, 'conform.json');
  if (!existsSync(manifestPath)) {
    // Conformance is opt-in: its absence only blocks a verdict when some law is stale and its rows would need checking.
    if (events.size) notYet.push(`${INTENT_DIR}/conform.json is missing: conformance rows and oracles not yet checked`);
    else notes.push(`${INTENT_DIR}/conform.json is missing: conformance is not set up`);
  } else {
    const manifest = json(manifestPath);
    if (manifest?.schema !== 1 || !Array.isArray(manifest.checks)) unavailable(`${INTENT_DIR}/conform.json requires schema: 1 and checks[]; fix the manifest`);
    for (const c of manifest.checks) {
      if (!c || typeof c.name !== 'string' || !Array.isArray(c.laws) || c.laws.some(l => typeof l !== 'string') || !Array.isArray(c.real) || c.real.some(a => typeof a !== 'string')) unavailable(`${INTENT_DIR}/conform.json: a check has no name, laws[] or real command; fix the manifest`);
      const hit = c.laws.filter(id => events.has(id));
      if (!hit.length) continue;
      const why = hit.map(id => events.get(id).what.has('was removed') ? `${phrase(id)} but the row still names it` : phrase(id)).join('; ');
      lines.push(`conform row "${c.name}" is stale: ${why}`);
      // Oracle = an argument of the row's real command that names an existing path inside the repository (resolved against the row's cwd).
      const cwd = resolve(root, typeof c.cwd === 'string' ? c.cwd : '.');
      c.real.forEach((arg, i) => {
        if (i === 0 && !/[\\/]/.test(arg)) return;
        const path = resolve(cwd, arg);
        const rel = relative(root, path);
        if (!rel || rel.startsWith('..') || /(^|[\\/])node_modules([\\/]|$)/.test(rel) || !existsSync(path)) return;
        lines.push(`oracle ${rel} is stale: conform row "${c.name}" is stale`);
      });
    }
  }
  return { base, lines, notYet, notes, status: lines.length || notYet.length ? 1 : 0 };
}

export async function explain(root, error) {
  if (!(error instanceof IntentError) || error.code !== 1) return error;
  try {
    const result = await impact(root);
    const extra = [...result.lines, ...result.notYet];
    if (extra.length) return new IntentError(`${error.message}\nstale dependents since ${result.base}:\n${extra.join('\n')}`, 1);
  } catch { /* the impact walk is best effort when a check already rejected */ }
  return error;
}

export function sinceArg(argv) {
  const rest = [];
  let since = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') {
      since = argv[++i];
      if (!since || since.startsWith('-')) unavailable('--since needs a git ref; use --since <git-ref>');
    } else rest.push(argv[i]);
  }
  return { root: rootArg(rest), since };
}

await cli(async argv => {
  verifyHeaders(import.meta.url);
  const { root, since } = sinceArg(argv);
  const result = await impact(root, since);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const line of [...result.lines, ...result.notYet.map(l => `not yet checked: ${l}`)]) console.log(line);
  if (!result.status) console.log(`intent-impact: nothing is stale since ${result.base}`);
  process.exitCode = result.status;
}, import.meta.url);
