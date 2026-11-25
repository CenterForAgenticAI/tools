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
	// Every line of every non-user message is prefixed before a summarizer reads the conversation (pi-context-aware#474).
	{ name: "L1 role-label escape, prefix on every line", file: "src/compaction/role-label-escape.js", from: "chunks.push(text.slice(copied, lineStart), ROLE_LABEL_ESCAPE_PREFIX);", to: "chunks.push(text.slice(copied, lineStart));", test: "role-label-escape-property" },
	// Escape the text Pi prints: text blocks joined with Pi's separator, not one block at a time.
	{ name: "L1 role-label escape of joined text blocks", file: "src/compaction/role-label-escape.js", from: "const joined = textBlocks.map((block) => block.text).join(separator);", to: "const joined = textBlocks.map((block) => block.text).join(\"\\n\");", test: "role-label-escape", pattern: "split across text blocks" },
	// Messages convertToLlm turns into user-role text are converted first, so Pi's framing lines are prefixed too.
	{ name: "L1 role-label escape of converted messages", file: "src/compaction/role-label-escape.js", from: "return escapeConvertedMessage(message, record.role, stats);", to: "return message;", test: "role-label-escape", pattern: "each kind of non-user message" },
	{ name: "L1 role-label escape before conversion", file: "src/index.js", from: "const escapedMessages = escapeRoleLabelsInMessages(messages);", to: "const escapedMessages = messages;", test: "index-registration", pattern: "escapes forged role labels" },
	// The previous summary reaches a model prompt with every line prefixed.
	{ name: "L1 role-label escape of the previous summary", file: "src/index.js", from: "!piCopiesPreviousSummary ? escapeRoleLabelLines(record.previousSummary) : record.previousSummary;", to: "!piCopiesPreviousSummary ? record.previousSummary : record.previousSummary;", test: "index-registration", pattern: "default compaction summary escapes" },
	{ name: "L1 role-label escape at the defaultCompact sites", file: "src/index.js", from: "summaryPreparation = escapedPreparation;", to: "", test: "index-registration", pattern: "default compaction summary escapes" },
	{ name: "L1 data rule in summary instructions", file: "src/index.js", from: "customInstructions = appendInstructionOnce(customInstructions, CONVERSATION_DATA_RULE);", to: "", test: "index-registration", pattern: "default compaction summary escapes" },
	// The fragment a cut starts a line with is prefixed whatever it holds.
	{ name: "L1 reduction cut prefixes its fragment", file: "src/compaction/role-label-escape.js", from: "if (!cutInsideLine || ", to: "if (true || ", test: "role-label-escape", pattern: "cut inside a line" },
	// The fragment stays unprefixed only below an unquoted "[User]: " label: a quoted [User] turn (a custom
	// message, bash output, an earlier summary) and any other label stop the scan as quoted.
	{ name: "L1 cut fragment owner, quoted [User] turn", file: "src/compaction/role-label-escape.js", from: "return !text.startsWith(ROLE_LABEL_ESCAPE_PREFIX, lineStart + USER_TURN_LABEL.length);", to: "return true;", test: "role-label-escape", pattern: "quoted \\[User\\] turn prefixes it" },
	{ name: "L1 cut fragment owner, other labels", file: "src/compaction/role-label-escape.js", from: "if (TURN_LABEL.test(text) || text.startsWith(\"<\", lineStart))", to: "if (false)", test: "role-label-escape", pattern: "whatever is above it" },
	{ name: "L1 head cut ends before a split prefix", file: "src/compaction/role-label-escape.js", from: "end = lineStart - 1;", to: "return head.slice(0, end);", test: "role-label-escape", pattern: "never ends inside the prefix" },
	// Every retry and fallback cut of a summary, seed or artifact prompt goes through the shared cut (CR-ESCAPE-RETRY-CUT-UNPREFIXED).
	{ name: "L1 retry cut through the shared cut", file: "src/index.js", from: "return reduceKeepingLabelsEscaped(text, absoluteMaxChars, (input, maxChars) => reduceTextForOverflowRetry(input, maxChars, rejectedPayloadChars));", to: "return reduceTextForOverflowRetry(text, absoluteMaxChars, rejectedPayloadChars);", test: "index-registration", pattern: "bare hostile line" },
	{ name: "L1 fallback and context cuts through the shared cut", file: "src/index.js", from: "return reduceKeepingLabelsEscaped(text, maxChars, reduceTextForOverflow, { textStart });", to: "return reduceTextForOverflow(text, maxChars);", test: "index-registration", pattern: "bare hostile line" },
	{ name: "C1 focus transcript authority", file: "src/workstream/workstream-context.js", from: "const replay = replayWorkstreamEntries(entries);", to: "const replay = replayWorkstreamEntries([]);", test: "safety-focus-authority" },
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
	{ name: "G1 untrusted project cannot raise the cap", file: "src/platform/config-layers.js", from: '    "toolOutputCap.maxBytes",\n', to: "", test: "index-registration", pattern: "untrusted project cannot raise" },
	// An untrusted project's own file sets no fold or strategy leaf (pi-context-aware#525).
	{ name: "G1 untrusted project sets no fold or strategy leaf", file: "src/platform/config-layers.js", from: 'leaf.startsWith("folds.") || leaf.startsWith("strategy.")', to: "false", test: "untrusted-fold-config", pattern: "sets no folds" },
	{ name: "G1 fold engine drops an untrusted project's ownership leaves", file: "src/folds/fold-engine.js", from: "projectTrusted(ctx) ? project : withoutUntrustedOwnership(project)", to: "project", test: "untrusted-fold-config", pattern: "sets no folds" },
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
	// The stores reach files through the held directory's identity path, never its pathname (pi-context-aware#246).
	{ name: "E2 erasure deletes through the held directory, not its pathname", file: "src/erasure/files.js", from: "return action(heldPath(fd));", to: "return action(directory);", test: "store-identity-swap", pattern: "#246 erasure" },
	{ name: "P1 parity store writes and reads through the held directory, not its pathname", file: "src/parity/records.js", from: "path: await heldPath(current)", to: "path: path.join(agentDir, ...dirs)", test: "store-identity-swap", pattern: "#246 parity" },
	{ name: "P1 metrics store appends and trims through the held directory, not its pathname", file: "src/parity/records.js", from: "path: await heldPath(current)", to: "path: path.join(agentDir, ...dirs)", test: "store-identity-swap", pattern: "#246 metrics" },
	// Each step of the walk, not only the last, opens through the held parent's identity path (caair/pi/pi-context-aware!402 review round 1).
	{ name: "E2 erasure walks each parent through its held directory, not its pathname", file: "src/erasure/files.js", from: "const next = fs.openSync(`${heldPath(fd)}/${part}`, flags);", to: "const next = fs.openSync(path.join(root, relative.split(part)[0], part), flags);", test: "store-identity-swap", pattern: "#246 erasure: the grandparent" },
	{ name: "P1 parity store walks each parent through its held directory, not its pathname", file: "src/parity/records.js", from: "current = await openChildDir(await heldPath(parent), part, create);", to: "current = await openChildDir(path.join(agentDir, ...dirs.slice(0, dirs.indexOf(part))), part, create);", test: "store-identity-swap", pattern: "#246 parity: the grandparent" },
	{ name: "P1 metrics store walks each parent through its held directory, not its pathname", file: "src/parity/records.js", from: "current = await openChildDir(await heldPath(parent), part, create);", to: "current = await openChildDir(path.join(agentDir, ...dirs.slice(0, dirs.indexOf(part))), part, create);", test: "store-identity-swap", pattern: "#246 metrics: the grandparent" },
	// With no identity path that verifies, the stores refuse; none falls back to a pathname.
	{ name: "E2 erasure walk refuses without an identity path", file: "src/erasure/files.js", from: "${heldPath(fd)}/${part}", to: "${heldDirectoryPath(fd) ?? path.join(root, relative.split(part)[0])}/${part}", test: "store-identity-swap", pattern: "#246 refusal: when no identity path" },
	{ name: "E2 erasure delete refuses without an identity path", file: "src/erasure/files.js", from: "return action(heldPath(fd));", to: "return action(heldDirectoryPath(fd) ?? directory);", test: "store-identity-swap", pattern: "#246 refusal: when no identity path" },
	{ name: "P1 store walk refuses without an identity path", file: "src/parity/records.js", from: "await openChildDir(await heldPath(parent), part, create)", to: "await openChildDir(await heldPath(parent).catch(() => path.join(agentDir, ...dirs.slice(0, dirs.indexOf(part)))), part, create)", test: "store-identity-swap", pattern: "#246 refusal: when no identity path" },
	{ name: "P1 store directory refuses without an identity path", file: "src/parity/records.js", from: "path: await heldPath(current)", to: "path: await heldPath(current).catch(() => path.join(agentDir, ...dirs))", test: "store-identity-swap", pattern: "#246 refusal: when no identity path" },
	{ name: "E2 session listing refuses without an identity path", file: "src/erasure/extension.js", from: "const held = heldDirectoryPath(fd);", to: "const held = heldDirectoryPath(fd) ?? directory;", test: "store-identity-swap", pattern: "#246 refusal: the session listing" },
	{ name: "E2 /.vol is offered only on macOS", file: "src/erasure/files.js", from: "if (process.platform === \"darwin\")", to: "if (true)", test: "store-identity-swap", pattern: "#246 platform" },
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
	// Fold savings in context_status (pi-context-aware#414): the savings line, savings kept apart from the summary-writing cost, and recovery counted only for fold refs.
	{ name: "S1 fold savings lines in the folds view", file: "src/context-tools/context-status.js", from: "...formatFoldAccounting(accounting),", to: "", test: "context-status", pattern: "#414: the folds view reports measured savings" },
	{ name: "S1 fold savings line in the M1 scenario", file: "src/context-tools/context-status.js", from: "...formatFoldAccounting(accounting),", to: "", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 savings" },
	{ name: "S2 savings never subtract the summary-writing cost", file: "src/folds/fold-savings.js", from: "tokens: Math.max(0, originalTokens - summaryTokens),", to: "tokens: Math.max(0, originalTokens - summaryTokens - foldOutput),", test: "m1-exit-scenario", pattern: "REQ-FOLD-004 savings" },
	{ name: "S3 recovery counts only recalls of folds", file: "src/folds/fold-savings.js", from: "recallResults.filter((result) => folds.has(result.ref))", to: "recallResults", test: "context-status", pattern: "#414: the folds view reports measured savings" },
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
	// context_recall as a client of pi-memory search: each guard of the requester and the card filter goes red when removed.
	{ name: "PM absent without ack", file: "src/context-tools/pi-memory-search.js", from: "if (!acked && replies === 0)", to: "if (false)", test: "context-recall-pi-memory", pattern: "with no responder" },
	{ name: "PM second reply refused", file: "src/context-tools/pi-memory-search.js", from: "if (replies > 1)", to: "if (false)", test: "context-recall-pi-memory", pattern: "replies twice" },
	{ name: "PM throwing listener caught", file: "src/context-tools/pi-memory-search.js", from: "return finish({ status: \"threw\" });", to: "throw new Error(\"unguarded listener\");", test: "context-recall-pi-memory", pattern: "on a bus that rethrows a listener's error" },
	{ name: "PM deadline not late", file: "src/context-tools/pi-memory-search.js", from: "finish({ status: \"timeout\", timeoutMs }), timeoutMs);", to: "finish({ status: \"timeout\", timeoutMs }), timeoutMs + 1000);", test: "context-recall-pi-memory", pattern: "the deadline is exactly the requested timeout" },
	{ name: "PM deadline not early", file: "src/context-tools/pi-memory-search.js", from: "finish({ status: \"timeout\", timeoutMs }), timeoutMs);", to: "finish({ status: \"timeout\", timeoutMs }), timeoutMs - 1);", test: "context-recall-pi-memory", pattern: "the deadline is exactly the requested timeout" },
	{ name: "PM timer cleared on settle", file: "src/context-tools/pi-memory-search.js", from: "clearTimeout(timer);", to: ";", test: "context-recall-pi-memory", pattern: "answered call leaves no timer" },
	{ name: "PM late reply ignored", file: "src/context-tools/pi-memory-search.js", from: "if (settled)\n                    return;\n                replies += 1;", to: "replies += 1;", test: "context-recall-pi-memory", pattern: "late reply is ignored" },
	{ name: "PM card count bound", file: "src/context-tools/pi-memory-search.js", from: "if (cards.length > PI_MEMORY_MAX_CARDS)", to: "if (false)", test: "context-recall-pi-memory", pattern: "more than five cards" },
	{ name: "PM card sessionId check", file: "src/context-tools/pi-memory-search.js", from: "if (typeof sessionId !== \"string\" || sessionId === \"\")", to: "if (false)", test: "context-recall-pi-memory", pattern: "no sessionId" },
	{ name: "PM unknown error kind refused", file: "src/context-tools/pi-memory-search.js", from: "if (!ERROR_KINDS.includes(error))", to: "if (false)", test: "context-recall-pi-memory", pattern: "unknown error kind" },
	{ name: "PM snippet bound", file: "src/context-tools/pi-memory-search.js", from: "snippet: bound(card.snippet, bounds.snippetCharacters, bounds),", to: "snippet: card.snippet,", test: "context-recall-pi-memory", pattern: "oversized card fields" },
	{ name: "PM alsoIn bound", file: "src/context-tools/pi-memory-search.js", from: "alsoIn.slice(0, MAX_ALSO_IN_SHOWN)", to: "alsoIn", test: "context-recall-pi-memory", pattern: "oversized card fields" },
	{ name: "PM long query not sent", file: "src/context-tools/context-recall.js", from: "query.length > PI_MEMORY_MAX_QUERY_CHARS", to: "false", test: "context-recall-pi-memory", pattern: "over 1000 characters" },
	{ name: "PM prior repo filter", file: "src/context-tools/context-recall.js", from: "if (scope === \"prior\" && card.repo !== repo)", to: "if (false)", test: "context-recall-pi-memory", pattern: "prior keeps only cards" },
	{ name: "PM erased card dropped", file: "src/context-tools/context-recall.js", from: "if (erased.has(card.sessionId))", to: "if (false)", test: "context-recall-pi-memory", pattern: "erased session" },
	{ name: "PM own session card dropped", file: "src/context-tools/context-recall.js", from: "if (card.sessionId === sessionId)", to: "if (false)", test: "context-recall-pi-memory", pattern: "include_current adds" },
	{ name: "PM session scope stays local", file: "src/context-tools/context-recall.js", from: "scope !== \"session\" && !regex", to: "!regex", test: "context-recall-pi-memory", pattern: "scope session never asks" },
	{ name: "PM regex stays local", file: "src/context-tools/context-recall.js", from: "!regex && request.case_sensitive", to: "request.case_sensitive", test: "context-recall-pi-memory", pattern: "regex query never asks" },
	{ name: "PM case-sensitive stays local", file: "src/context-tools/context-recall.js", from: "request.case_sensitive !== true && includeWorktrees", to: "includeWorktrees", test: "context-recall-pi-memory", pattern: "case-sensitive query never asks" },
	{ name: "PM worktrees-off stays local", file: "src/context-tools/context-recall.js", from: "request.case_sensitive !== true && includeWorktrees", to: "request.case_sensitive !== true", test: "context-recall-pi-memory", pattern: "include_worktrees false never asks" },
	{ name: "PM surface uses pi.events", file: "src/context-tools/context-recall.js", from: "searchEvents: pi.events", to: "searchEvents: undefined", test: "context-recall-pi-memory", pattern: "registered tool asks" },
	// The plan checker (pi-context-aware#468, REQ-STRAT-002): removing each rule makes its rule test in tests/strategy-check-plan.test.ts fail.
	{ name: "S1 tool pairs: a stub of a tool-call entry", file: "src/strategy-runtime/check-plan.js", from: "if ((entry.toolCallIds?.length ?? 0) > 0)", to: "if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 tool pairs" },
	{ name: "S2 protected zone: a stub of a protected entry", file: "src/strategy-runtime/check-plan.js", from: "else if (view.protectedEntryIds.includes(entry.id))", to: "else if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 protected zone" },
	{ name: "S3 recoverable: a stub no context edit can replace", file: "src/strategy-runtime/check-plan.js", from: "if (!RECOVERABLE_ROLES.has(entry.role))", to: "if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 recoverable" },
	{ name: "S4 fold hints: a fold of verbatim entries", file: "src/strategy-runtime/check-plan.js", from: "if (coverage.verbatim > 0)", to: "if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 fold hints" },
	{ name: "S5 summary bounds: a cut-off summary", file: "src/strategy-runtime/check-plan.js", from: "return error === undefined ? [] : [refusal(\"summary-stub\", error)];", to: "return [];", test: "strategy-check-plan", pattern: "REQ-STRAT-002 summary bounds" },
	{ name: "S6 already folded: a stub of a folded or hidden entry", file: "src/strategy-runtime/check-plan.js", from: "if (by !== undefined)", to: "if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 already folded" },
	{ name: "S7 one writer: another owner holds the compaction claim", file: "src/strategy-runtime/check-plan.js", from: "if (options.compaction === true && op.kind === \"summarize\" && view.compactionOwner === \"other\") {", to: "if (false) {", test: "strategy-check-plan", pattern: "REQ-STRAT-002 one writer" },
	// The one-writer rule is for compaction only (CR-ONE-WRITER-DECISION): the old rule for every write refuses the model's folds.
	{ name: "S15 folds unaffected by the compaction claim", file: "src/strategy-runtime/check-plan.js", from: "if (options.compaction === true && op.kind === \"summarize\" && view.compactionOwner === \"other\") {", to: "if (op.kind !== \"say\" && view.compactionOwner === \"other\") {", test: "compaction-claim-refusal", pattern: "rival holder" },
	// The compaction trigger is checked as a compaction, so another owner's claim refuses it.
	{ name: "S16 compaction trigger checked as a compaction", file: "src/strategy-runtime/live/stage-loop.js", from: "const check = checkPlan(view, plan, engine, { compaction: true });", to: "const check = checkPlan(view, plan, engine);", test: "compaction-claim-refusal", pattern: "rival holder" },
	// While another owner holds the claim, the view does not offer context_compact, so no nudge names it.
	{ name: "S17 no context_compact offer while a rival compacts", file: "src/index.js", from: "contextCompactReachable(pi, ctx, readConfig(ctx)) && claimController.owner !== \"other\"", to: "contextCompactReachable(pi, ctx, readConfig(ctx))", test: "compaction-claim-refusal", pattern: "never context_compact" },
	// A session that cannot reach context_compact keeps the default arm's hedged context_fold guideline (CR-FOLD-FIRST-GUIDELINE-UNREACHABLE-COMPACT, pi-context-aware#459).
	{ name: "S17 no steered context_compact guideline where the tool is unreachable", file: "src/index.js", from: "contextCompactNamed(ctx) ? foldEngine.steer(ctx) : \"default\"", to: "foldEngine.steer(ctx)", test: "fold-nudge-reachable-tools", pattern: "CR-FOLD-FIRST-GUIDELINE-UNREACHABLE-COMPACT" },
	// A context tool whose method the session does not run is named nowhere, though a Fabric host reaches it hidden (CR-FOLD-ONLY-COMPACT-NUDGE, pi-context-aware#526).
	{ name: "S17 no offer of a tool whose method is off: the strategy view", file: "src/index.js", from: "reachableToolNames(pi).filter((name) => toolOfferedBy(methods, name))", to: "reachableToolNames(pi)", test: "fold-nudge-reachable-tools", pattern: "a registered context_fold is still not named" },
	{ name: "S17 no offer of a tool whose method is off: the check-in", file: "src/index.js", from: "return hasMethod(sessionMethods(ctx), \"compact\") && contextAwareCompactionAvailable(cfg)", to: "return contextAwareCompactionAvailable(cfg)", test: "fold-nudge-reachable-tools", pattern: "neither the system prompt nor the check-in" },
	{ name: "S17 no offer of a tool whose method is off: the system prompt", file: "src/index.js", from: "compact: compactionAvailable && compactTool.available && toolOfferedBy(methods, \"context_compact\"),", to: "compact: compactionAvailable && compactTool.available,", test: "fold-nudge-reachable-tools", pattern: "neither the system prompt nor the check-in" },
	{ name: "S17 no offer of a tool whose method is off: the context_fold guidelines", file: "src/index.js", from: "contextFoldSurface.apply(surface, hasMethod(methods, \"compact\"));", to: "contextFoldSurface.apply(surface);", test: "fold-nudge-reachable-tools", pattern: "guidelines do not name context_compact" },
	{ name: "S17 no offer of a tool whose method is off: a refold refusal", file: "src/folds/fold-refusal.js", from: "refoldAdvice(advise, context.compact !== false)", to: "refoldAdvice(advise, true)", test: "fold-refusal", pattern: "a refold refusal keeps the fold-id merge" },
	{ name: "S17 no offer of a tool whose method is off: a refusal with no range left", file: "src/context-tools/context-fold.js", from: "refusalTail(result, compactOffered())", to: "refusalTail(result)", test: "fold-refusal", pattern: "no range left to fold" },
	// Without compact, a context_compact call is refused and Pi writes the summary of a threshold or overflow compaction (CR-FOLD-ONLY-COMPACTION-UNTESTED).
	{ name: "S17 without compact, context_compact is refused", file: "src/index.js", from: "if (recipeDecision === \"no-stage\")\n", to: "if (false)\n", test: "compaction-claim-refusal", pattern: "is refused with one bounded line" },
	{ name: "S17 without compact, Pi writes the compaction summary", file: "src/index.js", from: "if (recipeDecision === \"refused\" || recipeDecision === \"no-stage\") {", to: "if (recipeDecision === \"refused\") {", test: "compaction-claim-refusal", pattern: "goes ahead with Pi's own summary" },
	{ name: "S8 reachable tools: a say naming a tool outside the view", file: "src/strategy-runtime/check-plan.js", from: "const unreachable = toolsNamedIn(ownWords(op), view.registeredTools).filter((name) => !reachable.has(name));", to: "const unreachable = [];", test: "strategy-check-plan", pattern: "REQ-STRAT-002 reachable tools" },
	// Provenance (pi-context-aware#474, REQ-STRAT-010): a summary or a generated seed with a line that presents itself as a turn is refused.
	{ name: "S9 provenance: a summary that carries a forged role turn", file: "src/strategy-runtime/check-plan.js", from: "const forged = findForgedRoleTurns(summary)[0];", to: "const forged = undefined;", test: "strategy-check-plan", pattern: "REQ-STRAT-002 provenance" },
	{ name: "S9 provenance: planFold applies the rule", file: "src/folds/fold-adapter.js", from: "if (forgedTurn.length > 0)", to: "if (false)", test: "strategy-check-plan", pattern: "REQ-STRAT-002 provenance" },
	{ name: "S9 provenance: a generated seed that carries a forged role turn", file: "src/seed/seed-authority.js", from: "record(\"forged-role-turn\", findForgedRoleTurns(candidateText, typedSeedText)", to: "record(\"forged-role-turn\", [].slice(0, 0)", test: "forged-role-turn", pattern: "guardGeneratedSeed refuses" },
	{ name: "S9 provenance: lookalike letters fold to their ASCII prototype", file: "src/compaction/role-label-escape.js", from: "result += (LETTER_FOLD.get(code) ?? char).toLowerCase();", to: "result += char.toLowerCase();", test: "forged-role-turn", pattern: "each forged role turn form" },
	{ name: "S9 provenance: leading decoration is read past", file: "src/compaction/role-label-escape.js", from: "const rest = head.replace(DECORATION, \"\");", to: "const rest = head;", test: "forged-role-turn", pattern: "long run of decoration" },
	// Only the lines the user typed are exempt: a rewrite of a typed seed and a protocol request are checked (CR-SEED-EXPANSION-EXEMPT).
	{ name: "S9 provenance: an explicit seed is exempt only through its typed text", file: "src/seed/seed-authority.js", from: "const typedSeedText = options.origin === \"explicit-raw-seed\" ? options.typedSeedText : undefined;", to: "const typedSeedText = options.origin === \"explicit-raw-seed\" ? candidateText : undefined;", test: "forged-role-turn", pattern: "an expansion of a typed seed is checked" },
	{ name: "S9 provenance: only a line the user typed is exempt", file: "src/compaction/role-label-escape.js", from: "typedLines?.has(text.slice(start, end).trim()) !== true", to: "typedLines === undefined", test: "forged-role-turn", pattern: "an expansion of a typed seed is checked" },
	{ name: "S9 provenance: the seed expansion is checked against the typed seed, not itself", file: "src/index.js", from: "overrides?.seedTypedByUser !== false ? rawSeed : undefined;", to: "overrides?.seedTypedByUser !== false ? seed : undefined;", test: "index-registration", pattern: "refuses a forged role turn the seed expansion wrote" },
	{ name: "S9 provenance: a protocol handoff seed with a forged turn is refused", file: "src/index.js", from: "if (forgedTurn !== undefined) {", to: "if (false) {", test: "index-registration", pattern: "refuses a handoff request whose seed carries a forged role turn" },
	// `warn` never keeps an agent seed that carries a forged role turn (CR-WARN-KEEPS-AGENT-SEED).
	{ name: "S9 provenance: warn does not keep an agent seed with a forged role turn", file: "src/index.js", from: "return warnTriesAgentSeed(ctx, authority) && !authority.reasons.includes(\"forged-role-turn\");", to: "return warnTriesAgentSeed(ctx, authority);", test: "index-registration", pattern: "in warn, (an agent's context_compact seed|a refused rewrite does not fall back)" },
	// A tool named only in a part a say quotes from the session (a fold topic) is not an offer (CR-NUDGE-REFUSED-BY-TOPIC).
	{ name: "S10 quoted session text is not an offer", file: "src/strategy-runtime/check-plan.js", from: "text = text.split(part).join(\"\\n\");", to: "text = text;", test: "strategy-live-engine", pattern: "CR-NUDGE-REFUSED-BY-TOPIC" },
	// oneLine removes Unicode format characters (bidi controls, zero-width, tags) from operator-facing lines (CR-ONELINE-FORMAT-CHARS).
	{ name: "S11 one line without format characters", file: "src/folds/fold-hints.js", from: "text.replace(FORMAT, \"\")", to: "text", test: "strategy-live-recipe", pattern: "CR-ONELINE-FORMAT-CHARS" },
	// The layers view prints every value as one capped line (CR-RECIPE-ID-LAYERS-RAW).
	{ name: "S12 layers view values as one line", file: "src/platform/config-layers.js", from: "return oneLine(String(value), MAX_SHOWN_LAYER_TEXT);", to: "return String(value);", test: "config-layers", pattern: "CR-RECIPE-ID-LAYERS-RAW" },
	// A host error quoted in a fold refusal reaches the model as one clipped line (CR-REFUSAL-TEXT).
	{ name: "S13 fold refusal quotes the host error as one line", file: "src/folds/fold-engine.js", from: "const reason = oneLine(error instanceof Error ? error.message : String(error), MAX_VIEW_ERROR_CHARS);", to: "const reason = error instanceof Error ? error.message : String(error);", test: "strategy-live-engine", pattern: "CR-REFUSAL-TEXT" },
	// The once-per-turn nudge gate closes only on a nudge the request carried, not on one rendered and refused (CR-GATE-CONTROL-PROOF).
	{ name: "S14 nudge gate closes only on an injected nudge", file: "src/folds/fold-turn.js", from: "if (sentNudge !== undefined && turn.nudge?.breakdown?.emergencyOverride !== 1)", to: "if (rendered.size > 0 && turn.nudge?.breakdown?.emergencyOverride !== 1)", test: "fold-turn", pattern: "CR-GATE-CONTROL-PROOF" },
	// Only a claim refusal that names the rival holder makes another owner (CR-CLAIM-REFUSAL-NOT-RIVAL): Fabric's other refusals are no claim.
	{ name: "S18 only a rival refusal makes another owner", file: "src/compaction/owner-claim.js", from: "settled = attempt.rival ? \"rival\" : \"refused\";", to: "settled = \"rival\";", test: "compaction-claim-refusal", pattern: "CR-CLAIM-REFUSAL-NOT-RIVAL" },
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
	// SAFETY_MUTATION_FILTER=<text> runs only the controls whose name contains the text.
	const filter = process.env.SAFETY_MUTATION_FILTER;
	const selected = filter ? mutations.filter((mutation) => mutation.name.includes(filter)) : mutations;
	assert.ok(selected.length > 0, `no safety mutation name contains ${JSON.stringify(filter)}`);
	for (const mutation of selected) {
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
	console.log(`Mutation checks passed: ${selected.length} controls; every restored replay passed.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
