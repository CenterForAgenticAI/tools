#!/usr/bin/env node
/**
 * Experimental live-model benchmark for context-aware seed expansion prompt R&D.
 *
 * This is intentionally NOT part of `npm test`. It calls real LLM providers via
 * pi-ai, using the same seed-expansion system prompt, tagged streaming protocol,
 * preview extraction, and parser used by the extension.
 *
 * Usage examples:
 *   npm run bench:live -- --models openai/gpt-5-mini --fixtures clear,ambiguous
 *   npm run bench:live -- --models anthropic/claude-sonnet-4.5,openai/gpt-5-mini --repeats 3
 *
 * Auth/model resolution uses Pi SDK ModelRuntime + ModelRegistry, so it sees the
 * normal ~/.pi/agent/auth.json, ~/.pi/agent/models.json, environment variables,
 * OAuth credentials, and custom provider fallback behavior. It still runs
 * outside an interactive Pi session, so it does not use the currently selected
 * session model unless you pass it via --models.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	SEED_EXPANSION_SYSTEM_PROMPT,
	parseSeedExpansionResult,
	seedExpansionPreview,
	textFromResponseContent,
} from "../.test-dist/seed-expansion.js";

const FIXTURES = [
	{
		id: "clear-item-3",
		description: "Latest active checklist has a clear item #3: design tests/benchmarks.",
		rawSeed: "continue with item #3",
		expectedAction: "proceed",
		conversation: `User wants to improve agent/extensions/context-aware.

Current implementation notes:
- Raw compaction seeds are rewritten before compaction.
- The expander uses a streaming-friendly tagged protocol with <expanded_seed_prompt> or <question>.
- Full compaction must wait until seed expansion and approval finish.

Latest active plan:
1. Add transcript path annotation to compaction summaries. Done.
2. Rename /compact-now to /compact-then. Done.
3. Design and build tests and benchmarks for seed expansion and compaction handoff. Next.

Relevant files:
- agent/extensions/context-aware/index.ts
- agent/extensions/context-aware/seed-expansion.ts
- agent/extensions/context-aware/seed-expansion-spec.md
- agent/extensions/context-aware/package.json
- agent/extensions/context-aware/tsconfig.json

Verification command: tsc -p agent/extensions/context-aware/tsconfig.json --noEmit --pretty false.`,
		mustInclude: ["test", "benchmark", "agent/extensions/context-aware", "compact"],
		mustNotInclude: ["rename /compact-now"],
	},
	{
		id: "ambiguous-item-3",
		description: "Two plausible item #3 lists should trigger clarification.",
		rawSeed: "continue with item #3",
		expectedAction: "clarify",
		conversation: `Earlier UI plan:
1. Add spinner.
2. Improve status bar.
3. Add color theme support.

Later compaction plan:
1. Extract parser helpers.
2. Add streaming preview tests.
3. Add sequencing tests proving compaction does not start before seed expansion and approval.

The user has not said which plan to continue. Both item #3 entries are plausible next tasks depending on product direction.`,
		mustInclude: ["item #3"],
		mustNotInclude: [],
	},
	{
		id: "self-contained",
		description: "Raw seed is already clear; model should preserve scope without adding unrelated work.",
		rawSeed:
			"Design a practical test and benchmark suite for context-aware seed expansion and compaction handoff. Include streaming UI, ambiguity modes, command/tool paths, transcript metadata, and sequencing tests.",
		expectedAction: "proceed",
		conversation: `The context-aware extension lives at agent/extensions/context-aware. It rewrites raw compaction seeds into self-contained prompts, uses the active conversation model for seed expansion, supports ambiguity modes ask/cautious-proceed/always-proceed, and exposes /compact-then and compact_session. The user now wants prompt R&D and benchmarks for the rewrite behavior.`,
		mustInclude: ["streaming", "ambiguity", "compact_session", "/compact-then"],
		mustNotInclude: ["search_prior_sessions"],
	},
	{
		id: "missing-context",
		description: "No meaningful task context; model should clarify rather than hallucinate.",
		rawSeed: "finish this",
		expectedAction: "clarify",
		conversation: `User: ok thanks.
Assistant: Sounds good.`,
		mustInclude: ["finish this"],
		mustNotInclude: ["agent/extensions/context-aware/index.ts", "implement"],
	},
	{
		id: "long-distractor-session",
		description: "Longer transcript with completed distractors and final active task.",
		rawSeed: "do the next thing",
		expectedAction: "proceed",
		conversation: `${Array.from({ length: 25 }, (_, i) => `Completed historical task ${i + 1}: investigate unrelated module ${i + 1}. Old plan item #3 was cleanup docs for module ${i + 1}.`).join("\n")}

Final current branch summary:
- Implemented tagged seed expansion.
- User tested the UI and requested live prompt streaming plus a distinct compaction loading state.
- The next concrete task is to run live LLM prompt R&D benchmarks for seed expansion behavior, measuring time-to-first-preview-token, rewrite duration, parse success, ambiguity classification, and quality.
- Keep normal CI deterministic; live model calls should be an experimental benchmark only.`,
		mustInclude: ["live", "benchmark", "time-to-first", "quality"],
		mustNotInclude: ["module 1", "cleanup docs"],
	},
];

function parseArgs(argv) {
	const args = {
		models: process.env.CONTEXT_AWARE_BENCH_MODELS ?? "",
		fixtures: "all",
		repeats: Number(process.env.CONTEXT_AWARE_BENCH_REPEATS ?? "1"),
		out: "",
		maxTokens: 4096,
		concurrency: Number(process.env.CONTEXT_AWARE_BENCH_CONCURRENCY ?? "1"),
		thinking: process.env.CONTEXT_AWARE_BENCH_THINKING ?? "off",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--models" || arg === "--model") args.models = argv[++i] ?? "";
		else if (arg === "--fixtures") args.fixtures = argv[++i] ?? "all";
		else if (arg === "--repeats") args.repeats = Number(argv[++i] ?? "1");
		else if (arg === "--out") args.out = argv[++i] ?? "";
		else if (arg === "--max-tokens") args.maxTokens = Number(argv[++i] ?? "4096");
		else if (arg === "--concurrency") args.concurrency = Number(argv[++i] ?? "1");
		else if (arg === "--thinking") args.thinking = argv[++i] ?? "off";
		else if (arg === "--list-available") args.listAvailable = true;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

const THINKING_LEVEL_PLACEHOLDER = "Pi-supported-level";

export function formatThinkingLevels(levels) {
	return levels.join("|");
}

export function getHelpText() {
	return `Live seed-expansion benchmark\n\nOptions:\n  --models <provider/id[,provider/id...]>  Required unless CONTEXT_AWARE_BENCH_MODELS is set\n  --fixtures <all|id[,id...]>             Default: all\n  --repeats <n>                           Default: 1\n  --out <path.jsonl>                      Default: bench-results/seed-expansion-<timestamp>.jsonl\n  --max-tokens <n>                        Default: 4096\n  --concurrency <n>                       Concurrent model/fixture/repeat jobs. Default: 1\n  --thinking <${formatThinkingLevels(["off", THINKING_LEVEL_PLACEHOLDER])}>  Pi-supported reasoning level for every selected model. Default: off\n  --list-available                        List models available through Pi SDK auth and exit\n\nExamples:\n  npm run bench:live -- --models openai/gpt-5-mini --thinking off\n  npm run bench:live -- --models anthropic/claude-sonnet-4.5,openai/gpt-5-mini --fixtures clear-item-3,ambiguous-item-3 --repeats 3 --concurrency 2 --thinking medium`;
}

function printHelp() {
	console.log(getHelpText());
}

export function validateThinkingLevel(level, modelEntries) {
	if (level === "off") return level;
	for (const { modelRef, model } of modelEntries) {
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(level)) {
			throw new Error(`Model ${modelRef} does not support --thinking ${level}. Supported levels: ${formatThinkingLevels(supported)}`);
		}
	}
	return level;
}

export function buildStreamOptions({ apiKey, headers, maxTokens, model, thinking }) {
	const base = { apiKey, headers, maxTokens };
	return model.reasoning && thinking !== "off" ? { ...base, reasoning: thinking } : base;
}

function parseModelRef(ref) {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`Invalid model ref: ${ref}. Expected provider/id.`);
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function selectFixtures(spec) {
	if (!spec || spec === "all") return FIXTURES;
	const wanted = new Set(spec.split(",").map((s) => s.trim()).filter(Boolean));
	const selected = FIXTURES.filter((f) => wanted.has(f.id));
	const missing = [...wanted].filter((id) => !FIXTURES.some((f) => f.id === id));
	if (missing.length) throw new Error(`Unknown fixture(s): ${missing.join(", ")}`);
	return selected;
}

function buildContext(fixture) {
	return {
		systemPrompt: SEED_EXPANSION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `<conversation>\n${fixture.conversation}\n</conversation>\n\n<raw-seed>\n${fixture.rawSeed}\n</raw-seed>\n\nRewrite the raw seed now.`,
					},
				],
				timestamp: Date.now(),
			},
		],
	};
}

function scoreResult(fixture, parsed, finalText) {
	const resultText = parsed?.action === "proceed"
		? parsed.expanded_seed_prompt
		: parsed?.action === "clarify"
			? `${parsed.question}\n${parsed.blocking_reason}\n${parsed.options?.join("\n") ?? ""}`
			: finalText;
	const lower = resultText.toLowerCase();
	const includes = fixture.mustInclude.filter((s) => lower.includes(s.toLowerCase())).length;
	const forbidden = fixture.mustNotInclude.filter((s) => lower.includes(s.toLowerCase())).length;
	const actionCorrect = parsed?.action === fixture.expectedAction;
	let score = 1;
	if (parsed) score += 1;
	if (actionCorrect) score += 1;
	if (fixture.mustInclude.length === 0 || includes === fixture.mustInclude.length) score += 1;
	if (forbidden === 0) score += 1;
	return {
		qualityScore: Math.max(1, Math.min(5, score)),
		actionCorrect,
		mustIncludeHitCount: includes,
		mustIncludeCount: fixture.mustInclude.length,
		forbiddenHitCount: forbidden,
	};
}

async function runOne({ modelRef, model, apiKey, headers, fixture, repeat, maxTokens, thinking }) {
	const started = performance.now();
	let firstAnyDeltaMs = null;
	let firstPreviewMs = null;
	let previewUpdateCount = 0;
	let previewCharsAtTTFP = null;
	let finalText = "";
	let streamedText = "";
	let lastPreviewKind = null;
	let stopReason = null;
	let usage = null;
	let error = null;

	try {
		const streamOptions = buildStreamOptions({ apiKey, headers, maxTokens, model, thinking });
		const events = streamSimple(model, buildContext(fixture), streamOptions);
		for await (const event of events) {
			const now = performance.now();
			if (event.type === "text_delta") {
				if (firstAnyDeltaMs === null) firstAnyDeltaMs = now - started;
				streamedText += event.delta;
				const progress = seedExpansionPreview(streamedText);
				previewUpdateCount++;
				lastPreviewKind = progress.kind;
				if (firstPreviewMs === null && progress.kind !== "raw_json" && progress.preview.length > 0) {
					firstPreviewMs = now - started;
					previewCharsAtTTFP = progress.preview.length;
				}
			} else if (event.type === "text_end") {
				streamedText = event.content;
			} else if (event.type === "done") {
				stopReason = event.reason;
				usage = event.message.usage;
				finalText = textFromResponseContent(event.message.content);
			} else if (event.type === "error") {
				stopReason = event.reason;
				usage = event.error.usage;
				finalText = textFromResponseContent(event.error.content);
				error = event.error.errorMessage ?? event.reason;
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	const rewriteDurationMs = performance.now() - started;
	if (!finalText) finalText = streamedText;
	const parsed = finalText ? parseSeedExpansionResult(finalText) : null;
	const quality = scoreResult(fixture, parsed, finalText);
	return {
		ts: new Date().toISOString(),
		model: modelRef,
		thinkingLevel: model.reasoning ? thinking : "off",
		modelSupportsReasoning: !!model.reasoning,
		fixture: fixture.id,
		fixtureDescription: fixture.description,
		repeat,
		rawSeed: fixture.rawSeed,
		expectedAction: fixture.expectedAction,
		parsedAction: parsed?.action ?? null,
		parseOk: !!parsed,
		stopReason,
		error,
		timeToFirstAnyDeltaMs: firstAnyDeltaMs === null ? null : Math.round(firstAnyDeltaMs),
		timeToFirstPreviewTokenMs: firstPreviewMs === null ? null : Math.round(firstPreviewMs),
		rewriteDurationMs: Math.round(rewriteDurationMs),
		previewUpdateCount,
		previewCharsAtTTFP,
		lastPreviewKind,
		seedInputTokens: usage?.input ?? null,
		seedOutputTokens: usage?.output ?? null,
		seedTotalTokens: usage?.totalTokens ?? null,
		qualityScore: quality.qualityScore,
		actionCorrect: quality.actionCorrect,
		mustIncludeHitCount: quality.mustIncludeHitCount,
		mustIncludeCount: quality.mustIncludeCount,
		forbiddenHitCount: quality.forbiddenHitCount,
		expandedSeedPrompt: parsed?.action === "proceed" ? parsed.expanded_seed_prompt : null,
		clarificationQuestion: parsed?.action === "clarify" ? parsed.question : null,
		finalText,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.listAvailable && !args.models.trim()) {
		throw new Error("Missing --models provider/id. Example: npm run bench:live -- --models openai/gpt-5-mini");
	}
	const modelRuntime = await ModelRuntime.create();
	const modelRegistry = new ModelRegistry(modelRuntime);
	if (args.listAvailable) {
		const available = await modelRegistry.getAvailable();
		for (const model of available) console.log(`${model.provider}/${model.id}`);
		return;
	}
	const modelRefs = args.models.split(",").map((s) => s.trim()).filter(Boolean);
	const fixtures = selectFixtures(args.fixtures);
	const repeats = Math.max(1, Math.floor(args.repeats || 1));
	const outPath = args.out || path.join("bench-results", `seed-expansion-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });

	const resolvedModels = [];
	for (const modelRef of modelRefs) {
		const { provider, id } = parseModelRef(modelRef);
		const model = modelRegistry.find(provider, id);
		if (!model) throw new Error(`Model not found via Pi SDK ModelRegistry: ${modelRef}`);
		resolvedModels.push({ modelRef, model });
	}
	const thinking = validateThinkingLevel(args.thinking, resolvedModels);
	const modelEntries = [];
	for (const { modelRef, model } of resolvedModels) {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(`No usable auth found via Pi SDK ModelRegistry for ${modelRef}. Check ~/.pi/agent/auth.json, ~/.pi/agent/models.json, OAuth login, or provider env vars.`);
		}
		modelEntries.push({ modelRef, model, apiKey: auth.apiKey, headers: auth.headers });
	}

	const jobs = [];
	for (const entry of modelEntries) {
		for (const fixture of fixtures) {
			for (let repeat = 1; repeat <= repeats; repeat++) jobs.push({ entry, fixture, repeat });
		}
	}
	const concurrency = Math.max(1, Math.min(Math.floor(args.concurrency || 1), jobs.length || 1));
	let nextJob = 0;
	let completed = 0;
	console.log(`Writing JSONL results to ${outPath}`);
	console.log(`Running ${jobs.length} job(s) with concurrency ${concurrency}, thinking=${thinking}.`);

	async function worker(workerId) {
		while (true) {
			const jobIndex = nextJob++;
			if (jobIndex >= jobs.length) return;
			const { entry, fixture, repeat } = jobs[jobIndex];
			console.log(`[w${workerId}] start [${entry.modelRef}] ${fixture.id} repeat ${repeat}/${repeats}`);
			const result = await runOne({ ...entry, fixture, repeat, maxTokens: args.maxTokens, thinking });
			fs.appendFileSync(outPath, `${JSON.stringify(result)}\n`);
			completed++;
			console.log(
				`[w${workerId}] done ${completed}/${jobs.length} [${entry.modelRef}] ${fixture.id} repeat ${repeat}/${repeats}: ${result.parsedAction ?? "parse-fail"} score=${result.qualityScore}/5 ttfp=${result.timeToFirstPreviewTokenMs ?? "n/a"}ms rewrite=${result.rewriteDurationMs}ms${result.error ? ` error=${result.error}` : ""}`,
			);
		}
	}

	await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
	console.log(`Done. Results: ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
}
