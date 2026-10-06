// Shared offline policy and bounded process runner. No third-party dependencies.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTENT_DIR = '.intent';
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
// The one scanner for Bend source: codeOnly, lawIds and splitLaws all read the text through scanBend, char by char. It accepts a strict
// subset and rejects everything else as "unsupported layout at line N" instead of guessing what Bend would do. The token rules follow the
// literal forms in ~/.bend/guide/GUIDE.md:606 (U32 `42`, F32 `1.5`, Nat `3n`, Char `'c'`, String `"s"`) and "#" comments (GUIDE.md:364).
// Bend 2.0.35 ships its surface parser as JavaScript bundled inside the bend binary (~/.bend/bin/bend, a Bun bundle: parse_skip, parse_char,
// ESCAPES, NUMBER), so there is no source file to cite; those functions are the reference this subset was read from, and the Bend-backed
// oracle test in tests/unit/kit.test.mjs checks the subset against the binary. The guide's kernel parser (~/.bend/bend2/bendtt.lean:549-557)
// agrees that "#" runs to the end of the line. The subset is matched to Bend 2.0.35; recheck it when Bend changes.
//   comment  "#" to the end of the line (an LF ends it; nothing else does)
//   string   a double quote, then any text, with backslash escapes, to the next unescaped double quote; it may span lines (splitLaws refuses that)
//   char     one code point, or \n \r \t \0 \' \" \\ or \u{hex}, between single quotes; never ', a raw newline or a raw tab
//   number   decimal with an optional fraction, exponent and n suffix, or 0x / 0b; it may not touch a letter, digit, underscore or dot after it
//   rejected a single quote that is not a valid char, an unterminated string, a char or string touching a word on either side, a lone CR,
//            and Unicode space characters outside a literal
const NUMBER = /0[xX][0-9A-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nN]?/y;
const WORD = /[A-Za-z0-9_.]/;
// eslint-disable-next-line no-control-regex -- the control characters are the point: Bend does not treat them as plain spaces
const BAD_SPACE = /[\u000B\u000C\u0085\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/;
const ESCAPES = new Set(['n', 'r', 't', '0', "'", '"', '\\']);
export function scanBend(text, name = 'LAWS.bend') {
  const lineAt = at => text.slice(0, at).split('\n').length;
  const fail = (at, why) => reject(`${name}: unsupported layout at line ${lineAt(at)}: ${why}`);
  const glued = (start, end, what) => {
    if (start > 0 && WORD.test(text[start - 1]) || end < text.length && /[A-Za-z0-9_]/.test(text[end])) fail(start, `${what} touches a word; separate it with a space`);
  };
  let code = '';
  const multiline = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      if (/\r(?!\n)/.test(text.slice(i, stop + 1))) fail(i, 'a lone CR; use LF or CRLF line breaks');
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) fail(i, 'unterminated string');
        if (text[j] === '\\') {
          if (j + 1 >= text.length || text[j + 1] === '\n' || text[j + 1] === '\r') fail(j, 'backslash before a line break inside a string');
          j += 2;
        } else if (text[j] === '"') break;
        else j++;
      }
      glued(i, j + 1, 'a string');
      const breaks = text.slice(i, j).split('\n').length - 1;
      if (breaks) multiline.push(lineAt(i));
      code += '""' + '\n'.repeat(breaks);
      i = j + 1;
    } else if (c === "'") {
      let j = i + 1;
      if (text[j] === '\\') {
        const unicode = /^\\u\{[0-9A-Fa-f]{1,8}\}/.exec(text.slice(j, j + 12));
        if (unicode) j += unicode[0].length;
        else if (ESCAPES.has(text[j + 1])) j += 2;
        else fail(i, 'a character literal with an unknown escape');
      } else {
        const cp = text.codePointAt(j);
        if (cp === undefined || cp === 39 || cp === 10 || cp === 13 || cp === 9) fail(i, "a single quote that is not a one-character literal ('''', a raw newline and a raw tab are not supported)");
        j += cp > 0xFFFF ? 2 : 1;
      }
      if (text[j] !== "'") fail(i, 'a single quote that is not a one-character literal');
      glued(i, j + 1, 'a character literal');
      code += "'_'";
      i = j + 1;
    } else if (c >= '0' && c <= '9' && (i === 0 || !WORD.test(text[i - 1]))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      const end = i + m[0].length;
      if (end < text.length && WORD.test(text[end])) fail(i, 'a number touches a word; separate it with a space');
      code += m[0];
      i = end;
    } else if (c === '\r' && text[i + 1] !== '\n') fail(i, 'a lone CR; use LF or CRLF line breaks');
    else if (BAD_SPACE.test(c)) fail(i, 'a Unicode space character outside a string or comment; use a plain space');
    else { code += c; i++; }
  }
  return { code, multiline };
}
// Constructs the gate refuses in every authored file: @unsafe, a partial def (def f?(...)) anywhere on a line, ?TODO.
export const FORBIDDEN_BEND = /@\s*unsafe\b|\bdef\s+[\w.]+\?\s*\(|\?\s*TODO\b/;
export function codeOnly(text, name) { return scanBend(text, name).code; }
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
  checkLayout(text);
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
// --- Modules (receipt schema 2) -------------------------------------------------------------------------------
// A record may declare `## Modules`: one bullet per module, `- <name>: R1-R3, R7; laws: a, b, prefix_*`.
// Each module is judged against its own slice of the record and laws, so large models stay under the Jev token ceiling.
const MODULE_LINE = /^- ([a-z][a-z0-9-]{0,63}): (R[1-9]\d*(?:-R[1-9]\d*)?(?:, R[1-9]\d*(?:-R[1-9]\d*)?)*); laws: (\S.*)$/;
// One line splitter, one heading detector and one rule detector for modular records. Every line of the record lands in exactly
// one span: 'excluded' (the Modules section itself), 'rule' (an R<n> line in Rules, kept only by the module that owns the clause)
// or 'shared' (everything else, kept by every module). record() and modules() are cross-checked against these spans.
export function recordSpans(text) {
  let section = '';
  return text.split('\n').map(raw => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const heading = line.startsWith('## ') ? line.slice(3).trimEnd() : undefined;
    if (heading !== undefined) section = heading;
    if (section === 'Modules') return { raw, heading, kind: 'excluded' };
    const m = section === 'Rules' && heading === undefined ? /^R([1-9]\d*): (.+)$/.exec(line) : null;
    return m ? { raw, kind: 'rule', clause: `R${m[1]}` } : { raw, heading, kind: 'shared' };
  });
}
export function modules(recordText, clauses, laws) {
  if (!/^## Modules\s*$/m.test(recordText)) return null;
  // JavaScript treats a lone CR, U+2028 and U+2029 as line breaks in ^/$, but the record is split on LF, so they could hide or move text.
  if (/\r(?!\n)|[\u2028\u2029]/.test(recordText)) reject('record: with Modules, line breaks must be LF or CRLF; replace a lone CR, U+2028 or U+2029');
  const spans = recordSpans(recordText);
  const at = spans.findIndex(s => s.heading === 'Modules');
  if (spans.filter(s => s.heading === 'Modules').length > 1) reject('record: duplicate Modules section; keep one');
  // Each module sees only its own rules, so a rule must be one line: a continuation line would be reattributed to the clause above it.
  // A line before R1 (an intro) is shared by every module's state and cannot be reattributed.
  const inRules = []; let rules = false;
  for (const s of spans) { if (s.heading !== undefined) rules = s.heading === 'Rules'; else if (rules) inRules.push(s); }
  const stray = inRules.slice(Math.max(inRules.findIndex(s => s.kind === 'rule'), 0)).find(s => s.kind !== 'rule' && s.raw.trim());
  if (stray) reject(`record: with Modules, each rule must be one \`R<n>: ...\` line; found "${stray.raw.trim().slice(0, 60)}" (put detail in Worked examples or Vocabulary)`);
  // The rule lines of the spans must be exactly the clauses record() found, so no rule line can be dropped from every module.
  if (spans.filter(s => s.kind === 'rule').map(s => s.clause).join() !== clauses.map(c => c.id).join()) reject('record: parser disagreement on the rules; use plain "R<n>: text" lines under "## Rules"');
  const lines = [];
  for (const s of spans.slice(at + 1)) { if (s.heading !== undefined) break; lines.push(s.raw.trimEnd()); }
  const moduleLines = lines.filter(Boolean);
  if (!moduleLines.length) reject('record: empty Modules section; declare modules or remove the section');
  const byId = new Map(clauses.map(c => [c.id, c]));
  const names = new Set();
  const claimedClauses = new Map();
  const claimedLaws = new Map();
  const out = moduleLines.map(line => {
    const m = MODULE_LINE.exec(line);
    if (!m) reject(`record: bad Modules line "${line.slice(0, 80)}"; use "- name: R1-R3, R7; laws: id, prefix_*"`);
    const [, name, clauseSpec, lawSpec] = m;
    if (names.has(name)) reject(`record: duplicate module ${name}`);
    names.add(name);
    const ids = [];
    for (const token of clauseSpec.split(', ')) {
      const [from, to = token] = token.split('-');
      const a = Number(from.slice(1)), b = Number(to.slice(1));
      if (a > b) reject(`record: module ${name} clause range ${token} runs backwards`);
      for (let n = a; n <= b; n++) {
        const id = `R${n}`;
        if (!byId.has(id)) reject(`record: module ${name} names unknown clause ${id}`);
        if (claimedClauses.has(id)) reject(`record: clause ${id} is in both module ${claimedClauses.get(id)} and ${name}; each clause belongs to exactly one module`);
        claimedClauses.set(id, name);
        ids.push(id);
      }
    }
    const own = [];
    for (const token of lawSpec.split(',').map(t => t.trim())) {
      if (!/^[A-Za-z_][\w.]*\*?$/.test(token)) reject(`record: module ${name} has a bad law pattern "${token}"; use an id or a prefix ending in *`);
      const hits = token.endsWith('*') ? laws.filter(l => l.startsWith(token.slice(0, -1))) : laws.filter(l => l === token);
      if (!hits.length) reject(`record: module ${name} law pattern ${token} matches no law`);
      for (const law of hits) {
        if (claimedLaws.has(law)) reject(`record: law ${law} is in both module ${claimedLaws.get(law)} and ${name}; each law belongs to exactly one module`);
        claimedLaws.set(law, name);
        own.push(law);
      }
    }
    return { name, clauses: ids.map(id => byId.get(id)), laws: own };
  });
  const loose = clauses.filter(c => !claimedClauses.has(c.id)).map(c => c.id);
  if (loose.length) reject(`record: clause(s) ${loose.join(', ')} are in no module; assign every clause to one module`);
  const free = laws.filter(l => !claimedLaws.has(l));
  if (free.length) reject(`record: law(s) ${free.join(', ')} are in no module; assign every law to one module`);
  return out;
}
// The layout rules every reader of LAWS.bend relies on, with or without modules. Bend reads a top-level declaration after a lone CR, after
// indentation, after a literal or number, or after `}` on the same line, but the readers see declarations only at column zero of an LF line,
// so such a declaration would be hidden from the law ids and the gate, or glued to the block above and dropped from every other module.
// Everything outside the accepted subset is refused as "unsupported layout at line N" (see scanBend).
export function checkLayout(lawsText) {
  const { code, multiline } = scanBend(lawsText);
  // A string may span lines in Bend, but a continuation line at column zero would then look like a declaration, so it is refused.
  if (multiline.length) reject(`LAWS.bend: unsupported layout at line ${multiline[0]}: a string must stay on one line; split the text or use two strings`);
  const lines = code.split('\n').map(raw => raw.replace(/\r$/, ''));
  lines.forEach((line, index) => {
    const where = `LAWS.bend: unsupported layout at line ${index + 1}`;
    const shown = line.trim().slice(0, 40);
    if (/^\s+(?:def|type|import|law)\b/.test(line)) reject(`${where}: "${shown}" is not a column-zero declaration; keep every top-level declaration at column zero`);
    const rest = line.slice(/^(?:def|type|import|law)\b/.exec(line)?.[0].length ?? 0);
    if (/(?:^|[^\w.])(?:def|type|import|law)(?:\s|$)/.test(rest)) reject(`${where}: "${shown}" has a second declaration on one line; put each declaration on its own line at column zero`);
    if (!line || /^\s/.test(line) || /^(?:def|type|import|law)(?:\s|$)/.test(line)) return;
    // Bend's only decorator is @unsafe, on its own line directly above a def; any other column-zero @ line is a binder inside a body.
    if (/^@unsafe\s*$/.test(line) && /^def(?:\s|$)/.test(lines.slice(index + 1).find(next => next.trim()) ?? '')) return;
    reject(`${where}: "${shown}" is column-zero text that is not a declaration, an @unsafe line above a def, a comment or a blank line; indent the body of a declaration`);
  });
}
// Split LAWS.bend into top-level blocks. A block starts at a column-zero declaration; blank, indented and comment
// lines belong to the block above, except a run of column-zero comment lines directly above a declaration, which is that
// declaration's doc and belongs to the block below. `id` is set for `law <id>:` blocks. Joining the blocks with newlines restores the text.
export function splitLaws(lawsText) {
  checkLayout(lawsText);
  const blocks = [];
  for (const line of lawsText.split('\n')) {
    if (/^[A-Za-z_@]/.test(line) || !blocks.length) {
      const prev = blocks.at(-1)?.lines;
      const doc = [];
      while (prev && prev.length > 1 && /^#/.test(prev.at(-1))) doc.unshift(prev.pop());
      blocks.push({ id: /^law\s+([A-Za-z_][\w.]*)\s*:/.exec(line)?.[1] ?? null, lines: [...doc, line] });
    } else blocks.at(-1).lines.push(line);
  }
  const ids = lawIds(lawsText);
  const found = blocks.filter(b => b.id).map(b => b.id);
  if (found.length !== ids.length || found.some((id, i) => id !== ids[i])) reject('LAWS.bend: unsupported layout: a law is not a column-zero `law <id>:` block; keep declarations at column zero');
  return blocks.map(b => ({ id: b.id, text: b.lines.join('\n') }));
}
// The state a module is judged against: the record without the Modules section and with only this module's rules, and
// LAWS.bend with every non-law block (imports, types, helpers) plus only this module's laws.
export function moduleState(recordText, blocks, mod) {
  const keep = new Set(mod.clauses.map(c => c.id));
  const record = recordSpans(recordText).filter(s => s.kind === 'shared' || (s.kind === 'rule' && keep.has(s.clause))).map(s => s.raw).join('\n');
  const own = new Set(mod.laws);
  return { record, laws: blocks.filter(b => !b.id || own.has(b.id)).map(b => b.text).join('\n') };
}
function verifyModules(value, rec, lawsText, recordText, declared) {
  const fields = ['schema', 'recordId', 'recordSha256', 'lawsSha256', 'policy', 'model', 'modules', 'verdict', 'integrity'];
  if (!value || Object.keys(value).sort().join() !== fields.sort().join()) reject('receipt: unexpected format; regenerate with intent-receipt');
  const { integrity, ...body } = value;
  if (integrity !== sha256(canonical(body))) reject('receipt was hand-edited or corrupted; regenerate with intent-receipt, do not reseal it by hand');
  if (value.recordId !== rec.id || canonical(value.policy) !== canonical(POLICY) || typeof value.model !== 'string' || !value.model.trim()) reject('receipt: stale schema, identity, model or policy; regenerate with intent-receipt');
  if (!declared) reject('receipt is schema 2 but the record declares no modules; regenerate with intent-receipt');
  if (value.recordSha256 !== sha256(recordText) || value.lawsSha256 !== sha256(lawsText)) reject('receipt hashes are stale for LAWS.bend or the record; get human approval then regenerate with intent-receipt');
  const stored = value.modules;
  if (!stored || typeof stored !== 'object' || Object.keys(stored).sort().join() !== declared.map(m => m.name).sort().join()) reject('receipt: modules do not match the record; regenerate with intent-receipt');
  const blocks = splitLaws(lawsText);
  let all = true;
  for (const mod of declared) {
    const entry = stored[mod.name];
    const fieldsOf = ['clauses', 'laws', 'stateSha256', 'questions', 'answers', 'verdict'];
    if (!entry || Object.keys(entry).sort().join() !== fieldsOf.sort().join()) reject(`receipt: module ${mod.name} has an unexpected format; regenerate with intent-receipt`);
    if (canonical(entry.clauses) !== canonical(mod.clauses.map(c => c.id)) || canonical(entry.laws) !== canonical(mod.laws)) reject(`receipt: module ${mod.name} clauses or laws changed; regenerate with intent-receipt`);
    if (entry.stateSha256 !== sha256(canonical(moduleState(recordText, blocks, mod)))) reject(`receipt: module ${mod.name} state is stale; regenerate with intent-receipt`);
    const questions = { coverage: coverageQuestions(mod.clauses, mod.laws), fidelity: fidelityQuestions(mod.clauses, mod.laws, entry.answers?.coverage ?? {}) };
    if (canonical(entry.questions) !== canonical(questions)) reject(`receipt: module ${mod.name} questions are stale or altered; regenerate with intent-receipt`);
    const computed = verdict(mod.clauses, mod.laws, entry.answers?.coverage, entry.answers?.fidelity);
    if (entry.verdict !== computed) reject(`receipt: module ${mod.name} verdict does not match its answers; regenerate with intent-receipt`);
    if (computed !== 'pass') all = false;
  }
  if (value.verdict !== (all ? 'pass' : 'reject') || !all) reject('receipt policy rejects a module; revise its laws with approval and regenerate with intent-receipt');
}

export function verifyReceipt(value, rec, lawsText, recordText) {
  const declared = modules(recordText, rec.clauses, lawIds(lawsText));
  if (value?.schema === 2) return verifyModules(value, rec, lawsText, recordText, declared);
  if (declared) reject('record declares modules but the receipt is schema 1; regenerate with intent-receipt');
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
  if (basename(dir) !== 'tools' || basename(dirname(dir)) !== INTENT_DIR) return; // Only .intent/tools carries vendored body hashes.
  // Only files owned by the kit: adopting apps may keep unrelated tools here.
  const scripts = ['gen-enums', 'intent-check', 'intent-conform', 'intent-core', 'intent-gate', 'intent-impact', 'intent-receipt', 'inventory'];
  let version;
  for (const name of scripts.map(name => `${name}.mjs`)) {
    const text = read(join(dir, name));
    const lines = text.split('\n');
    const index = lines[0].startsWith('#!') ? 1 : 0;
    const match = /^\/\/ pi-intent v(\S+) sha256=([a-f0-9]{64})$/.exec(lines[index]);
    lines.splice(index, 1);
    if (!match || sha256(lines.join('\n')) !== match[2] || (version && version !== match[1])) reject(`${INTENT_DIR}/tools/${name}: stale or missing pi-intent header; re-run pi-intent vendor after reviewing local changes`);
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
