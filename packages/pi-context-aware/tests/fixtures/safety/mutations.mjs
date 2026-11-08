#!/usr/bin/env node
/** Run after npm run test:compile. Never mutate checkout sources or installed
 * dependencies: each control is removed in a disposable compiled replay tree,
 * restored in finally, and its named test must then pass again. Offline only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "safety-mutations-"));
const sdk = "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
const mutations = [
	{ name: "C1 task prompt regeneration", file: "src/index.js", from: "buildTasksContextEnvelope(tasksSnapshot, {", to: "buildTasksContextEnvelope(null, {", test: "safety-task-focus-authority" },
	{ name: "C1 focus prompt regeneration", file: "src/index.js", from: "[PROMPT_SECTION.sessionFocus]: workstreamEnvelope,", to: "[PROMPT_SECTION.sessionFocus]: null,", test: "safety-task-focus-authority" },
	{ name: "C1 task transcript authority", file: "src/session-tasks/session-tasks.js", from: "const replay = replayTasksEntries(entries);", to: "const replay = replayTasksEntries([]);", test: "safety-task-focus-authority" },
	{ name: "C1 focus transcript authority", file: "src/workstream/workstream-context.js", from: "const replay = replayWorkstreamEntries(entries);", to: "const replay = replayWorkstreamEntries([]);", test: "safety-task-focus-authority" },
	{ name: "C2 branch-scoped context edits", file: sdk, from: "for (const entry of contextEntries) {\n        if (entry.type === \"context_edit\")", to: "for (const entry of entries) {\n        if (entry.type === \"context_edit\")", test: "safety-branch-leakage" },
	// Native planning keeps whole entries through the engine's turn groups and the withdrawal of split
	// entries (pi-context-aware#186); coverage widening still decides what a sparse legacy import folds.
	{ name: "C3 whole-entry and pair widening", file: "src/folds/fold-coverage.js", from: "const selected = new Set(ids);", to: "return [...ids];\n    const selected = new Set(ids);", test: "folds", pattern: "ACP import widens a partial entry" },
	{ name: "C3 call/result identity mapping", file: "src/folds/fold-adapter.js", from: "toolCallId: callId,", to: "", test: "safety-tool-history", pattern: "one result endpoint" },
	{ name: "C3 protected partial-entry withdrawal", file: "src/folds/fold-adapter.js", from: "const selected = withdrawSplitEntries(state.messages, block.effectiveMessageIds);", to: "const selected = new Set(block.effectiveMessageIds);", test: "safety-tool-history", pattern: "protected sibling" },
	// A summary limit that is not a finite number must not reach the engine: NaN or Infinity would switch its length check off (pi-context-aware#183).
	{ name: "C3 finite summary limit", file: "src/folds/fold-adapter.js", from: 'return typeof value === "number" && Number.isFinite(value) ? value : undefined;', to: "return value;", test: "fold-summary-max-chars", pattern: "not a finite number is ignored" },
	// A queued fold is written only while the selected branch holds the leaf it was requested on, live and after a restart (pi-context-aware#176).
	{ name: "C2 queued fold branch leaf", file: "src/folds/fold-recovery.js", from: "const offBranch = accepted.anchors.find((anchor) => !onBranch.has(anchor.entryId));", to: "const offBranch = undefined;", test: "safety-queued-branch", pattern: "REQ-176-1" },
	{ name: "C2 saved fold request branch leaf", file: "src/folds/fold-recovery.js", from: '...(recovery.leafEntryId !== undefined ? [{ entryId: recovery.leafEntryId, label: "branch leaf" }] : []),', to: "", test: "safety-queued-branch", pattern: "tool result landed" },
	{ name: "C4 context edit disk replay", file: sdk, from: "this.fileEntries = entries;", to: "this.fileEntries = entries.map(e => e.type === 'context_edit' ? { ...e, type: 'custom', customType: 'mutation-ignored-edit' } : e);", test: "safety-restart" },
	{ name: "C5 side-file error reporting", file: "src/parity/side-file.js", from: "export function snapshotSideFile(sessionFile) {", to: "export function snapshotSideFile(sessionFile) {\n    return { ok: true, text: '{\"schemaVersion\":1,\"blocks\":[]}', byRef: {}, blocks: [] };", test: "safety-corruption" },
	{ name: "C5 recorder diagnostic propagation", file: "src/parity/recorder.js", from: "const diffs = [call.diff, ...(after.ok ? [] : [after.diff])];", to: "const diffs = [];", test: "safety-corruption" },
	{ name: "C5 newer import schema refusal", file: "src/folds/acp-import.js", from: "!SUPPORTED_ACP_SCHEMA_VERSIONS.includes(schemaVersion)", to: "![1, 2].includes(schemaVersion)", test: "safety-corruption", pattern: "newer-schema" },
	{ name: "C5 malformed import refusal", file: "src/folds/acp-import.js", from: 'return { status: "unsupported", reason: "not JSON" };', to: 'return { status: "skipped", reason: "no-blocks" };', test: "safety-corruption", pattern: "malformed" },
	{ name: "C6 summary carrier persistence", file: "src/folds/fold-entries.js", from: "return [carrier, ...hidden, metadata];", to: "return [...hidden, metadata];", test: "safety-summary-visibility" },
	{ name: "C6 full summary rather than 200-char preview", file: "src/folds/fold-entries.js", from: "replacement: { content: summaryText },", to: "replacement: { content: summaryText.slice(0, 200) },", test: "safety-summary-visibility" },
	// Recoverable hide (pi-context-aware#268): each guard in planHides, the whole-entry filter and the id bounds has a test that goes red without it.
	{ name: "C7 acp import directBlockIds filter", file: "src/folds/acp-import.js", from: "directBlockIds: block.directBlockIds.filter((id) => imported.has(id)),", to: "directBlockIds: [...block.directBlockIds],", test: "acp-startup-import", pattern: "drops directBlockIds entries" },
	{ name: "C7 hide skips non-editable entries", file: "src/folds/hide-entries.js", from: "!isEditableEntry(entry) || ", to: "", test: "recoverable-hide", pattern: "would not let a context edit" },
	{ name: "C7 hide skips tool-call entries", file: "src/folds/hide-entries.js", from: '(core.contentType !== "text" && core.contentType !== "tool-result")', to: "false", test: "recoverable-hide", pattern: "one tool call" },
	{ name: "C7 hide skips multi-call entries", file: "src/folds/hide-entries.js", from: 'cores.length !== 1 || !core || core.id !== entry.id || (core.contentType !== "text" && core.contentType !== "tool-result")', to: "!core", test: "recoverable-hide", pattern: "several tool calls" },
	{ name: "C7 hide skips already shortened text", file: "src/folds/hide-entries.js", from: "text.length <= 2 * HIDE_KEEP_CHARS || text.includes(TRUNCATION_MARKER)", to: "text.length <= 2 * HIDE_KEEP_CHARS", test: "recoverable-hide", pattern: "already shortened" },
	{ name: "C7 hide queues whole entries only", file: "src/folds/fold-turn.js", from: "messages.filter((message) => baseIdOf(message.id) === message.id)", to: "messages.filter(() => true)", test: "recoverable-hide", pattern: "wholeEntryIds" },
	{ name: "C7 hide id bound", file: "src/folds/hide-entries.js", from: "/^h[1-9]\\d{0,8}$/u", to: "/^h[1-9]\\d*$/u", test: "recoverable-hide", pattern: "never hInfinity" },
	{ name: "C7 fold block id bound", file: "src/folds/fold-entries.js", from: "/^b[1-9]\\d{0,8}$/u", to: "/^b[1-9]\\d*$/u", test: "recoverable-hide", pattern: "never bInfinity" },
	{ name: "C7 acp import block id bound", file: "src/folds/acp-import.js", from: "/^b[1-9]\\d{0,8}$/u", to: "/^b[1-9]\\d*$/u", test: "acp-startup-import", pattern: "bounds block and run ids" },
	{ name: "C7 acp import run id bound", file: "src/folds/acp-import.js", from: "/^r[1-9]\\d{0,8}$/u", to: "/^r[1-9]\\d*$/u", test: "acp-startup-import", pattern: "bounds block and run ids" },
	// Native tool guards (pi-context-aware#255). Each control is removed in the compiled copy; the named test must go red.
	{ name: "G1 tool-output cap threshold", file: "src/guards/tool-guards.js", from: "if (total <= maxBytes)", to: "if (true)", test: "tool-guards", pattern: "cap: 49,999" },
	{ name: "G1 tool-output cap skipTools", file: "src/guards/tool-guards.js", from: "return !config.skipTools.includes(event.toolName);", to: "return true;", test: "tool-guards", pattern: "skipTools moves" },
	{ name: "G1 tool-output cap hook", file: "src/index.js", from: "if (shouldCapToolResult(cap, event)) {", to: "if (false) {", test: "index-registration", pattern: "toolOutputCap: default" },
	{ name: "G1 untrusted project cannot raise the cap", file: "src/index.js", from: '    "toolOutputCap.maxBytes",\n', to: "", test: "index-registration", pattern: "untrusted project cannot raise" },
	{ name: "G2 repetition run count", file: "src/guards/tool-guards.js", from: "run = fingerprint === last ? run + 1 : 1;", to: "run = 1;", test: "tool-guards", pattern: "repetition: counts" },
	{ name: "G2 component: ids are nested", file: "src/skills/skill-registry.js", from: ' || toolCallId.startsWith("component:")', to: "", test: "tool-guards", pattern: "component: is nested" },
	{ name: "G2 repetition key", file: "src/index.js", from: "if (typeof event.toolCallId !== \"string\" || !getRepetitionGuardConfig(readConfig(ctx)).enabled)\n            return;", to: "", test: "index-registration", pattern: "turns the guard off" },
	{ name: "G2 repetition warning delivery", file: "src/index.js", from: "if (count >= REPETITION_WARN_AT)", to: "if (false)", test: "index-registration", pattern: "repetitionGuard: warns" },
	{ name: "G3 overflow classification", file: "src/index.js", from: "if (!isContextOverflow(reply, contextWindow))", to: "if (false)", test: "index-registration", pattern: "overflowRecovery: not an overflow" },
	{ name: "G3 overflow single attempt", file: "src/index.js", from: "if (overflowRecoveryAttempted.has(sessionKey))\n        return;", to: "", test: "index-registration", pattern: "overflowRecovery: a real" },
	{ name: "G3 overflow key", file: "src/index.js", from: "if (!getOverflowRecoveryConfig(readConfig(ctx)).enabled)\n        return;\n    if (overflowRecoveryAttempted", to: "if (overflowRecoveryAttempted", test: "index-registration", pattern: "overflowRecovery: not an overflow" },
	{ name: "G3 overflow ignores another model", file: "src/index.js", from: "if (activeModel?.provider && reply.provider && activeModel.provider !== reply.provider)", to: "if (false)", test: "index-registration", pattern: "from another model" },
	{ name: "G3 overflow ignores another model id", file: "src/index.js", from: "if (activeModel?.id && reply.model && activeModel.id !== reply.model)", to: "if (false)", test: "index-registration", pattern: "from another model" },
	{ name: "G3 overflow ignores a stale request", file: "src/index.js", from: "reply.timestamp < turnStartedAt", to: "false", test: "index-registration", pattern: "from a stale request" },
	{ name: "G3 overflow ignores a mid-run steer", file: "src/index.js", from: "if (event.streamingBehavior === undefined && !hostReportsBusy(ctx))", to: "if (true)", test: "index-registration", pattern: "a steer sent during the request" },
	{ name: "G3 overflow never aborts a Fabric program", file: "src/index.js", from: "overflowRecoveryAttempted.add(sessionKey);\n    try {", to: "overflowRecoveryAttempted.add(sessionKey);\n    ctx.abort();\n    try {", test: "index-registration", pattern: "Fabric program runs" },
	// Each assertion the review of !305 added to the Fabric test has a control that makes it fail.
	{ name: "G3 Fabric program result passes through untouched", file: "src/index.js", from: "return changed ? { content } : undefined;", to: "return { content };", test: "index-registration", pattern: "Fabric program runs" },
	{ name: "G3 Fabric program result never aborts", file: "src/index.js", from: "const warning = repetitionWarnings.get(event.toolCallId);", to: "ctx.abort();\n        const warning = repetitionWarnings.get(event.toolCallId);", test: "index-registration", pattern: "Fabric program runs" },
	{ name: "G3 overflow arm with the fold engine", file: "src/index.js", from: "overflowRecoveryArmed.add(sessionKey);", to: "", test: "index-registration", pattern: "fold engine registered" },
	{ name: "G1 output cap with the fold engine", file: "src/index.js", from: "if (shouldCapToolResult(cap, event)) {", to: "if (false) {", test: "index-registration", pattern: "fold engine registered" },
	{ name: "G1 hook honours Pi truncation flag", file: "src/index.js", from: "alreadyTruncated: details?.truncation?.truncated === true", to: "alreadyTruncated: false", test: "index-registration", pattern: "already truncated" },
	{ name: "G3 success ends the overflow episode", file: "src/index.js", from: "// A reply that went through ends the episode.\n        overflowRecoveryAttempted.delete(sessionKey);", to: "", test: "index-registration", pattern: "ends the episode" },
	// Session erase, slice 1 (pi-context-aware#310): each refusal and guard of the tombstone engine goes red when removed.
	{ name: "E1 confinement to the sessions directory", file: "src/erasure/session-rewrite.js", from: 'if (!relative || relative.startsWith("..") || path.isAbsolute(relative))', to: "if (false)", test: "erasure-rewrite", pattern: "confinement: a path outside" },
	{ name: "E1 live ledger lease refusal", file: "src/erasure/session-rewrite.js", from: "db?.isOpen(sessionId) || ", to: "", test: "erasure-rewrite", pattern: "live ledger lease" },
	{ name: "E1 live registry projection refusal", file: "src/erasure/session-rewrite.js", from: "|| registryIsOpen(options.agentDir, new Set([sessionId]))", to: "", test: "erasure-rewrite", pattern: "live registry projection" },
	{ name: "E1 current session refusal", file: "src/erasure/session-rewrite.js", from: "sessionId === options.currentSessionId || ", to: "", test: "erasure-rewrite", pattern: "this process has open" },
	{ name: "E1 unsure liveness refuses", file: "src/erasure/session-rewrite.js", from: 'throw new RewriteRefusal("Cannot establish that the session is closed");', to: "open = false;", test: "erasure-rewrite", pattern: "liveness cannot be established" },
	{ name: "E1 tool-call ids are structure", file: "src/erasure/tombstone.js", from: "return { ...kept, arguments: { erased: marker } };", to: "return { ...kept, id: marker, arguments: { erased: marker } };", test: "erasure-rewrite", pattern: "tool-call id erases" },
	{ name: "E1 atomic replacement", file: "src/erasure/session-rewrite.js", from: "const replacement = writeReplacement(c.held, c.name, c.text, c.file.original.mode);", to: "fs.writeFileSync(path.join(c.held, c.name), c.text); const replacement = writeReplacement(c.held, c.name, c.text, c.file.original.mode);", test: "erasure-rewrite", pattern: "is atomic" },
	{ name: "E1 rewrite lock", file: "src/erasure/session-rewrite.js", from: "const release = acquireLock(held, name);", to: "const release = () => { };", test: "erasure-rewrite", pattern: "second rewrite started" },
	{ name: "E1 concurrent writer check", file: "src/erasure/session-rewrite.js", from: "if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs)", to: "if (false)", test: "erasure-rewrite", pattern: "changes while the rewrite runs" },
	{ name: "E1 backup only when asked", file: "src/erasure/session-rewrite.js", from: "const backup = options.backup ? writeBackup(held, name, file.original.text) : undefined;", to: "const backup = writeBackup(held, name, file.original.text);", test: "erasure-rewrite", pattern: "backup: kept only when asked" },
	{ name: "E1 ledger holds hashes, not text", file: "src/erasure/session-rewrite.js", from: "hash: contentHash(file.sessionId, id, line.raw)", to: "hash: line.raw", test: "erasure-rewrite", pattern: "rewrite ledger" },
	{ name: "E1 unreadable line holding the match refuses", file: "src/erasure/session-rewrite.js", from: "if (selection.rawHolds && lines.some(", to: "if (false && lines.some(", test: "erasure-rewrite", pattern: "line it cannot read" },
	// Slice 2 (pi-context-aware#365): derived stores, summaries and forks.
	{ name: "E2 cache document cleaner", file: "src/erasure/derived.js", from: "removeCacheTarget(options.agentDir, { directory, file: name });", to: "", test: "erasure-derived", pattern: "no file in the profile" },
	{ name: "E2 fold side file and parity cleaner", file: "src/erasure/derived.js", from: "removeStoreFile(options.agentDir, file);", to: "", test: "erasure-derived", pattern: "no file in the profile" },
	{ name: "E2 manifest description redaction", file: "src/erasure/derived.js", from: "entry.description = REDACTED_DESCRIPTION;", to: "", test: "erasure-derived", pattern: "no file in the profile" },
	{ name: "E2 manifest names are plain cache names", file: "src/erasure/derived.js", from: "if (!isSafeCacheFileName(name)) {", to: "if (false) {", test: "erasure-derived", pattern: "points outside its store" },
	{ name: "E2 summary over an erased range is tombstoned", file: "src/erasure/coverage.js", from: "kept).some((covered) => result.has(covered)))", to: "kept).some(() => false))", test: "erasure-derived", pattern: "compaction summary over" },
	{ name: "E2 fork rewritten only on consent", file: "src/erasure/erase-text.js", from: "if (await options.confirmFork(fork) !== true) {", to: "if (false) {", test: "erasure-derived", pattern: "one accepted, one declined" },
	{ name: "E2 cleaners refuse a redirected (symlinked) store directory", file: "src/erasure/files.js", from: "if (entry.isSymbolicLink())", to: "if (false)", test: "erasure-derived", pattern: "symlinked cache pool" },
	// Session erase, slice 3 (pi-context-aware#366): the command's refusals, preview and receipt.
	{ name: "E3 range endpoint: unknown ref refused", file: "src/erasure/range-refs.js", from: ": { ok: false, reason: \"Unknown message ref in range\" };", to: ": { ok: true, entryId: \"e1\" };", test: "erasure-command", pattern: "a range ref that does not resolve" },
	{ name: "E3 range endpoint: unknown entry id refused", file: "src/erasure/range-refs.js", from: ": { ok: false, reason: \"Unknown entry id in range\" };", to: ": { ok: true, entryId: \"e1\" };", test: "erasure-command", pattern: "a range ref that does not resolve" },
	{ name: "E3 range endpoints on one path", file: "src/erasure/session-rewrite.js", from: "throw new RewriteRefusal(\"Range endpoints are not on one path of the session tree, or are in reverse order\");", to: "return selected;", test: "erasure-command", pattern: "a range ref that does not resolve" },
	{ name: "E3 live session refused by the command", file: "src/erasure/session-rewrite.js", from: "db?.isOpen(sessionId) || ", to: "", test: "erasure-command", pattern: "a live session is refused" },
	{ name: "E3 session path confined by the command", file: "src/erasure/session-rewrite.js", from: "if (!relative || relative.startsWith(\"..\") || path.isAbsolute(relative))", to: "if (false)", test: "erasure-command", pattern: "outside the store" },
	{ name: "E3 preview writes nothing", file: "src/erasure/session-rewrite.js", from: "if (options.dryRun) {", to: "if (false) {", test: "erasure-command", pattern: "declining the preview writes nothing" },
	{ name: "E3 receipt withholds lines holding the erased text", file: "src/erasure/erase-command.js", from: "line.includes(needle) ? WITHHELD : line", to: "line", test: "erasure-command", pattern: "no line shown to the user" },
	{ name: "E3 preview withholds lines holding the erased text", file: "src/erasure/erase-command.js", from: "confirm: (title, message) => options.confirm(withhold(title, needle), withhold(message, needle))", to: "confirm: options.confirm", test: "erasure-command", pattern: "no line shown to the user" },
	{ name: "E3 receipt names declined forks", file: "src/erasure/erase-command.js", from: "untouched.push(`Declined fork", to: "void (`Declined fork", test: "erasure-command", pattern: "preview lists the entries" },
	{ name: "G4 summary unicode decode", file: "src/folds/fold-adapter.js", from: "const summary = sanitizeSummary(input.summary).text;", to: "const summary = input.summary;", test: "tool-guards", pattern: "planFold decodes" },
	// REQ-FOLD-004 (pi-context-aware#130): the M1 exit scenario in tests/m1-exit-scenario.test.ts goes red when any step of it is broken.
	{ name: "M1 summary carrier persistence", file: "src/folds/fold-entries.js", from: "return [carrier, ...hidden, metadata];", to: "return [...hidden, metadata];", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 compress and locate" },
	{ name: "M1 recall returns the carrier only", file: "src/context-tools/context-recall-ref.js", from: "const covered = hide ? [hide.targetId] : coveredEntryIds(record);", to: "const covered = hide ? [hide.targetId] : [record.carrierId];", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 exact recovery" },
	{ name: "M1 context edit disk replay", file: sdk, from: "this.fileEntries = entries;", to: "this.fileEntries = entries.map(e => e.type === 'context_edit' ? { ...e, type: 'custom', customType: 'mutation-ignored-edit' } : e);", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 restart" },
	{ name: "M1 branch-scoped context edits", file: sdk, from: "for (const entry of contextEntries) {\n        if (entry.type === \"context_edit\")", to: "for (const entry of entries) {\n        if (entry.type === \"context_edit\")", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 branch" },
	{ name: "M1 absorbed block dropped from the source chain", file: "src/context-tools/context-recall-ref.js", from: "if (record.blockId === ref)\n            found = record;", to: "if (record.blockId === ref && !foldRecordsOnBranch(branch).some((other) => other.record.directBlockIds.includes(ref)))\n            found = record;", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 multi-level" },
	{ name: "M1 recall resolves the last fold, not the named one", file: "src/context-tools/context-recall-ref.js", from: "if (record.blockId === ref)\n            found = record;", to: "if (true)\n            found = record;", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 distractor" },
	{ name: "M1 recall lists missing entries", file: "src/context-tools/context-recall-ref.js", from: "if (missing.length > 0)\n        lines.push(", to: "if (false)\n        lines.push(", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 missing source" },
	// Contributors on the context-aware service (pi-context-aware#300, REQ-CONTRIB-009): each control's test goes red without it.
	{ name: "R1 contributor reads only own fields", file: "src/contributors/contributors.js", from: 'const render = own(registration, "render");', to: "const render = registration.render;", test: "contributors", pattern: "copies only own named fields" },
	{ name: "R1 contributor text cap", file: "src/contributors/contributors.js", from: "text.length > MAX_CONTRIBUTION_CHARS || ", to: "", test: "contributors", pattern: "over 4,000 characters is skipped" },
	{ name: "R1 contributor turn budget", file: "src/contributors/contributors.js", from: "turnLeft -= ownerBudget - ownerLeft;", to: "", test: "contributors", pattern: "at most 8,000 characters" },
	{ name: "R1 contributor carry cap", file: "src/contributors/contributors.js", from: "if (text.length > ownerBudget) {", to: "if (false) {", test: "contributors", pattern: "carry text appears in the compaction summary" },
	{ name: "R4 contributor fold makes due", file: "src/contributors/contributors.js", from: "if (folded.has(last.anchorId))", to: "if (false)", test: "contributors", pattern: "fold that covers the last showing" },
	{ name: "R4 contributor dropped showing makes due", file: "src/contributors/contributors.js", from: 'return !(visible.get(last.anchorId) ?? "").includes(text);', to: "return false;", test: "contributors", pattern: "compaction that drops the last showing" },
	{ name: "R5 contributor changed text is due", file: "src/contributors/contributors.js", from: "last.digest !== digest || ", to: "", test: "contributors", pattern: "changed text is due again" },
	{ name: "R5 contributor showing is recorded", file: "src/index.js", from: "pi.appendEntry(CONTRIBUTOR_SHOWN_ENTRY_TYPE, { version: 1, shown: contributorTurn.shown });", to: "void 0;", test: "contributors", pattern: "unchanged text is shown once" },
	{ name: "R6 contributor state read from the branch", file: "src/contributors/contributors.js", from: "const showings = latestShowings(branch);", to: "const showings = latestShowings([]);", test: "contributors", pattern: "replays after a reload" },
	{ name: "R7 contributor reserved owner", file: "src/contributors/contributors.js", from: "if (ownerKey === CONTEXT_AWARE_HINT_OWNER)", to: "if (false)", test: "contributors", pattern: "context-aware is reserved" },
	{ name: "R7 contributor one live owner", file: "src/contributors/contributors.js", from: "if (owners.has(ownerKey))", to: "if (false)", test: "contributors", pattern: "context-aware is reserved" },
	{ name: "R7 contributor hints use its ownerKey", file: "src/contributors/contributors.js", from: 'condensed: own(hint, "condensed"),\n                ownerKey,', to: 'condensed: own(hint, "condensed"),\n                ownerKey: own(hint, "ownerKey") ?? ownerKey,', test: "contributors", pattern: "hints register under its own ownerKey" },
	{ name: "R7 contributor hints all or none", file: "src/folds/fold-hints.js", from: "checked.push(one);", to: "checked.push(one);\n            owners.set(one.key, one.hint.ownerKey);", test: "contributors", pattern: "hints register under its own ownerKey" },
	{ name: "R8 contributor guard needs v1", file: "src/context-service.js", from: "service?.contributors?.v1 === true", to: "service?.contributors !== undefined", test: "contributors", pattern: "the guard is true" },
];

function run(mutation) {
	const args = ["--test", ...(mutation.pattern ? [`--test-name-pattern=${mutation.pattern}`] : []), `tests/${mutation.test}.test.js`];
	const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 60_000,
		env: { ...process.env, HOME: path.join(root, "home"), PI_CODING_AGENT_DIR: path.join(root, "agent"), TMPDIR: root } });
	assert.equal(result.error, undefined, `${mutation.name}: replay did not terminate normally`);
	assert.equal(result.signal, null, `${mutation.name}: replay was killed`);
	return result;
}

try {
	fs.cpSync(path.join(project, ".test-dist"), root, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
	fs.mkdirSync(path.join(root, "home"));
	const deps = path.join(project, "node_modules");
	fs.mkdirSync(path.join(root, "node_modules"));
	// Copy only the SDK whose replay controls are mutated; all other dependencies
	// are read-only links. No kernel file is ever a mutation target.
	for (const name of fs.readdirSync(deps)) {
		if (name === "@earendil-works") {
			fs.mkdirSync(path.join(root, "node_modules", name));
			for (const pkg of fs.readdirSync(path.join(deps, name))) {
				const source = path.join(deps, name, pkg);
				const dest = path.join(root, "node_modules", name, pkg);
				if (pkg === "pi-coding-agent") fs.cpSync(source, dest, { recursive: true });
				else fs.symlinkSync(source, dest);
			}
		} else fs.symlinkSync(path.join(deps, name), path.join(root, "node_modules", name));
	}
	for (const mutation of mutations) {
		const target = path.join(root, mutation.file);
		const original = fs.readFileSync(target, "utf8");
		assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: control must match exactly once`);
		let red;
		try {
			fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
			red = run(mutation);
			assert.equal(red.status, 1, `${mutation.name}: mutant survived\n${red.stdout}\n${red.stderr}`);
			assert.match(red.stdout + red.stderr, /AssertionError/, `${mutation.name}: must fail an assertion, not setup`);
		} finally { fs.writeFileSync(target, original); }
		const green = run(mutation);
		assert.equal(green.status, 0, `${mutation.name}: restoration did not pass\n${green.stdout}\n${green.stderr}`);
		console.log(`CONTROL REMOVED: ${mutation.name}\n${red.stdout}${red.stderr}\nRESTORED: exit 0\n`);
	}
	console.log(`Mutation checks passed: ${mutations.length} controls; every restored replay passed.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
