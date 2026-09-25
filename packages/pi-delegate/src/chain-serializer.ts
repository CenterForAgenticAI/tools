/**
 * Phase C: round-trippable serialization for `.chain.md` files.
 *
 * Storage format (separate from the in-memory `ChainStep` AST that
 * `executeChain` consumes — chain files are deliberately flat / no
 * parallel-in-chain so they round-trip cleanly):
 *
 *   ---
 *   name: recon-plan-implement
 *   description: Three-step delivery pipeline.
 *   # any unknown keys land in extraFields and are preserved
 *   ---
 *
 *   ## scout
 *   artifact: context.md
 *
 *   Investigate {task} and write findings to context.md.
 *
 *   ## planner
 *   reads: context.md
 *   artifact: plan.md
 *
 *   Plan the work in plan.md based on {previous}.
 *
 *   ## worker
 *   reads: plan.md, plan.notes.md
 *   progress: true
 *
 *   Execute the plan from {previous}.
 *
 * A composed saved chain uses an explicit heading discriminant:
 *
 *   ## chain:reusable-review
 *
 *   Review {task}; the parent chain's prior output is {previous}.
 *
 * Step config keys (env, artifact, reads, model, thinking, thinkingMin, thinkingMax,
 * skills, progress) appear as
 * flat `key: value` lines AFTER the `## <agent>` heading and BEFORE
 * the task body. A blank line separates config from body. Either may
 * be empty.
 *
 * Phase B's parallel-in-chain shape (`{parallel: [...]}`) is NOT
 * representable here — it's a runtime-only construct. Chain files
 * stored on disk are sequential pipelines.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { warnRemovedPlaneConfigKey } from "./config.js";
import {
	type ChainFileConfig,
	type ChainFileSource,
	type ChainRunStepFileConfig,
	type ChainStepFileConfig,
	type ChainWorkerStepFileConfig,
	isChainReferenceStepFileConfig,
	isChainRunStepFileConfig,
} from "./agents.js";
import { parseEnvOverrides } from "./env-overrides.js";
import {
	validateSavedChainRunCommand,
	validateSavedChainRunCwd,
	validateSavedChainRunLabel,
	validateSavedChainRunTimeoutMs,
} from "./saved-chain-run.js";

/**
 * Frontmatter keys we recognise as canonical. Anything else is preserved
 * as a string in `extraFields` so manual user-added keys round-trip.
 */
const KNOWN_FRONTMATTER_KEYS = new Set(["name", "description"]);

/** Order in which step-config keys are written. Stable for diff-friendliness. */
type ChainWorkerSerializableField = keyof ChainWorkerStepFileConfig | "artifact";

const STEP_CONFIG_KEY_ORDER: ChainWorkerSerializableField[] = [
	"env",
	"artifact",
	"reads",
	"model",
	"thinking",
	"thinkingMin",
	"thinkingMax",
	"skills",
	"progress",
];

const RUN_CONFIG_KEY_ORDER: Array<keyof Omit<ChainRunStepFileConfig, "run">> = [
	"command",
	"cwd",
	"env",
	"timeoutMs",
];

// ── Parse ────────────────────────────────────────────────────────────────

/**
 * Parse a `.chain.md` file body into a `ChainFileConfig`. Throws on:
 *   - missing `name:` or `description:` in frontmatter
 *   - unrecognised step keys (treated as task body — see split logic)
 *
 * `source` and `filePath` are pass-through metadata supplied by the
 * caller (typically `loadChainsFromDir` or `handleCreate`).
 */
export function parseChain(
	content: string,
	source: ChainFileSource,
	filePath: string,
): ChainFileConfig {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description =
		typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name) throw new Error("chain frontmatter missing required field: name");
	if (!description) throw new Error("chain frontmatter missing required field: description");

	// Stash unknown frontmatter keys for round-trip.
	const extraFields: Record<string, string> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
		extraFields[key] = typeof value === "string" ? value : String(value);
	}

	const steps = parseSteps(body);
	const result: ChainFileConfig = {
		name,
		description,
		source,
		filePath,
		steps,
	};
	if (Object.keys(extraFields).length > 0) result.extraFields = extraFields;
	return result;
}

/**
 * Parse the step sections from the body. Each step starts with a
 * `## <agent>` heading. Within a section, leading `key: value` lines
 * (no blank line yet) are step config; everything after the first
 * blank line is the task body.
 */
function parseSteps(body: string): ChainStepFileConfig[] {
	const lines = body.split("\n");
	const steps: ChainStepFileConfig[] = [];
	let i = 0;
	// Skip leading blank lines / intro paragraphs that aren't ## headings.
	while (i < lines.length && !/^##\s+/.test(lines[i])) i++;
	while (i < lines.length) {
		const heading = lines[i].match(/^##\s+(.+)$/);
		if (!heading) {
			i++;
			continue;
		}
		const agent = heading[1].trim();
		i++;
		// Collect step body until the next `## ` heading (or EOF).
		const sectionLines: string[] = [];
		while (i < lines.length && !/^##\s+/.test(lines[i])) {
			sectionLines.push(lines[i]);
			i++;
		}
		const step = parseStepSection(agent, sectionLines);
		steps.push(step);
	}
	return steps;
}

/**
 * Parse a single step section: leading `key: value` lines (terminated
 * by a blank line) form the config; subsequent text is the task body.
 *
 * If there's no blank-line separator, all the `key: value` lines are
 * config and the body is empty. If the very first line is blank, the
 * config is empty and the rest is the task body.
 */
function parseStepSection(heading: string, lines: string[]): ChainStepFileConfig {
	if (heading.startsWith("chain:")) {
		return parseChainReferenceSection(heading, lines);
	}
	if (heading.startsWith("run:")) {
		return parseRunSection(heading, lines);
	}

	let i = 0;
	// Skip leading blank lines.
	while (i < lines.length && lines[i].trim() === "") i++;

	// Read config lines until the first blank line.
	const config: Partial<ChainWorkerStepFileConfig> = {};
	while (i < lines.length && lines[i].trim() !== "") {
		const m = lines[i].match(/^([a-zA-Z]+):\s*(.*)$/);
		if (!m) break; // Not a config line — must be part of task body.
		const key = m[1];
		const raw = m[2].trim();
		assignStepField(config, key, raw);
		i++;
	}
	// Skip the blank-line separator.
	if (i < lines.length && lines[i].trim() === "") i++;
	// Everything else is the task body.
	const taskLines = lines.slice(i);
	// Trim trailing blank lines.
	while (taskLines.length > 0 && taskLines[taskLines.length - 1]!.trim() === "") {
		taskLines.pop();
	}
	const task = taskLines.join("\n");
	return {
		agent: heading,
		task,
		...config,
	};
}

/**
 * Parse a saved-chain reference without sending its task body through the
 * worker-option parser. The first blank line is the canonical separator; all
 * text after it is task text, even when a line looks like `key: value`.
 */
function parseChainReferenceSection(heading: string, lines: string[]): ChainStepFileConfig {
	const chain = heading.slice("chain:".length).trim();
	if (!chain) throw new Error("chain reference heading must name a saved chain");

	let taskStart = 0;
	if (lines[0]?.trim() === "") {
		taskStart = 1;
	} else {
		const separatorIndex = lines.findIndex((line) => line.trim() === "");
		const preSeparatorLines = separatorIndex === -1 ? lines : lines.slice(0, separatorIndex);
		const removedField = preSeparatorLines.find((line) => /^\s*(output|outputFrom):\s*/.test(line));
		if (removedField) {
			const field = removedField.trim().split(":", 1)[0];
			throw new TypeError(`chain step ${field} is removed; declare artifact: instead`);
		}
		if (preSeparatorLines.some((line) => /^[a-zA-Z][a-zA-Z0-9_-]*:\s*/.test(line))) {
			throw new Error(
				"chain reference steps may only contain a task body; worker step options are not allowed",
			);
		}
	}

	const taskLines = lines.slice(taskStart);
	while (taskLines.length > 0 && taskLines[taskLines.length - 1]!.trim() === "") {
		taskLines.pop();
	}
	return { chain, task: taskLines.join("\n") };
}

function parseRunSection(heading: string, lines: string[]): ChainRunStepFileConfig {
	const rawLabel = heading.slice("run:".length).trim();
	if (!rawLabel) throw new Error("run stage heading must name a stage");
	const run = validateSavedChainRunLabel(rawLabel, "run stage heading label");
	const fields = new Map<string, string>();
	const allowed = new Set<string>(RUN_CONFIG_KEY_ORDER);
	let index = 0;
	while (index < lines.length && lines[index]!.trim() !== "") {
		const match = lines[index]!.match(/^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/);
		if (!match) break;
		const key = match[1]!;
		if (!allowed.has(key)) throw new Error(`unsupported run stage field '${key}'`);
		if (fields.has(key)) throw new Error(`duplicate run stage field '${key}'`);
		fields.set(key, match[2]!.trim());
		index += 1;
	}
	if (index < lines.length && lines[index]!.trim() === "") index += 1;
	if (lines.slice(index).some((line) => line.trim() !== "")) {
		throw new Error("run stages cannot contain a task body");
	}

	const rawCommand = fields.get("command");
	if (rawCommand === undefined || rawCommand.trim() === "") {
		throw new Error("run stage must declare a non-empty command");
	}
	const step: ChainRunStepFileConfig = {
		run,
		command: validateSavedChainRunCommand(rawCommand),
	};
	if (fields.has("cwd")) step.cwd = validateSavedChainRunCwd(fields.get("cwd"))!;
	if (fields.has("env")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fields.get("env")!);
		} catch {
			throw new TypeError("run stage env must be valid JSON mapping variable names to strings or null");
		}
		step.env = parseEnvOverrides(parsed, "run stage env");
	}
	if (fields.has("timeoutMs")) {
		const rawTimeout = fields.get("timeoutMs")!;
		const timeout = /^\d+$/u.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
		step.timeoutMs = validateSavedChainRunTimeoutMs(timeout, "run stage timeoutMs");
	}
	return step;
}

/** Assign a single config key onto a step config object. */
function assignStepField(target: Partial<ChainWorkerStepFileConfig>, key: string, raw: string): void {
	if (/^decision/i.test(key)) {
		warnRemovedPlaneConfigKey(`chain.${key}`);
		return;
	}
	switch (key) {
		case "env":
			if (raw.length > 0) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					throw new TypeError("chain step env must be valid JSON mapping variable names to strings or null");
				}
				target.env = parseEnvOverrides(parsed, "chain step env");
			}
			return;
		case "output":
		case "outputFrom":
			throw new TypeError(`chain step ${key} is removed; declare artifact: instead`);
		case "artifact":
			if (raw === "false") (target as ChainWorkerStepFileConfig & { artifact?: string | false }).artifact = false;
			else if (raw.length > 0) (target as ChainWorkerStepFileConfig & { artifact?: string | false }).artifact = raw;
			return;
		case "reads":
			if (raw === "false") target.reads = false;
			else if (raw.length > 0) {
				target.reads = raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}
			return;
		case "model":
			if (raw.length > 0) target.model = raw;
			return;
		case "thinking":
			if (raw === "false") target.thinking = false;
			else if (raw.length > 0) target.thinking = raw;
			return;
		case "thinkingMin":
			if (raw === "false") target.thinkingMin = false;
			else if (raw.length > 0) target.thinkingMin = raw;
			return;
		case "thinkingMax":
			if (raw === "false") target.thinkingMax = false;
			else if (raw.length > 0) target.thinkingMax = raw;
			return;
		case "skills":
			if (raw === "false") target.skills = false;
			else if (raw.length > 0) {
				target.skills = raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}
			return;
		case "progress":
			if (raw === "true") target.progress = true;
			else if (raw === "false") target.progress = false;
			return;

		default:
			// Unknown keys are not config — let the caller treat the line as
			// part of the task body. We can't easily get that across the
			// function boundary, so for now we drop unknown keys silently.
			return;
	}
}

// ── Serialise ───────────────────────────────────────────────────────────

/**
 * Serialize a `ChainFileConfig` back to a `.chain.md` body. Round-trips
 * through `parseChain` losslessly for every recognised field.
 *
 * Field order:
 *   1. Frontmatter: `name`, `description`, then any preserved
 *      `extraFields` keys in insertion order.
 *   2. For each step: `## <agent>` heading + step config in
 *      `STEP_CONFIG_KEY_ORDER` + blank line + task body.
 */
export function serializeChain(chain: ChainFileConfig): string {
	const lines: string[] = ["---", `name: ${chain.name}`, `description: ${chain.description}`];
	if (chain.extraFields) {
		for (const [key, value] of Object.entries(chain.extraFields)) {
			lines.push(`${key}: ${value}`);
		}
	}
	lines.push("---", "");

	for (const step of chain.steps) {
		const configLines: string[] = [];
		if (isChainReferenceStepFileConfig(step)) {
			lines.push(`## chain:${step.chain}`);
		} else if (isChainRunStepFileConfig(step)) {
			const run = validateSavedChainRunLabel(step.run);
			validateSavedChainRunCommand(step.command);
			validateSavedChainRunCwd(step.cwd);
			validateSavedChainRunTimeoutMs(step.timeoutMs);
			if (step.env !== undefined) parseEnvOverrides(step.env, "run stage env");
			lines.push(`## run:${run}`);
			for (const key of RUN_CONFIG_KEY_ORDER) {
				const rendered = renderRunConfigLine(key, step[key]);
				if (rendered !== null) configLines.push(rendered);
			}
		} else {
			if (step.agent.startsWith("chain:") || step.agent.startsWith("run:")) {
				throw new Error(
					`chain worker agent '${step.agent}' uses a heading namespace reserved for saved-chain references or run stages`,
				);
			}
			lines.push(`## ${step.agent}`);
			for (const key of STEP_CONFIG_KEY_ORDER) {
				const rendered = renderStepConfigLine(
					key,
					(step as ChainWorkerStepFileConfig & { artifact?: string | false })[key],
				);
				if (rendered !== null) configLines.push(rendered);
			}
		}
		for (const line of configLines) lines.push(line);
		lines.push(""); // blank-line separator (always present, even if no body)
		if (!isChainRunStepFileConfig(step) && step.task) {
			lines.push(step.task);
			lines.push("");
		}
	}
	// Ensure the file ends with a single trailing newline.
	while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") {
		lines.pop();
	}
	return lines.join("\n");
}

function renderRunConfigLine(
	key: keyof Omit<ChainRunStepFileConfig, "run">,
	value: unknown,
): string | null {
	if (value === undefined) return null;
	switch (key) {
		case "command":
			return `command: ${validateSavedChainRunCommand(value)}`;
		case "cwd":
			return `cwd: ${validateSavedChainRunCwd(value)!}`;
		case "env": {
			const env = parseEnvOverrides(value, "run stage env");
			const entries = Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right));
			return entries.length > 0 ? `env: ${JSON.stringify(Object.fromEntries(entries))}` : null;
		}
		case "timeoutMs":
			return `timeoutMs: ${validateSavedChainRunTimeoutMs(value)!}`;
		default:
			return null;
	}
}

/**
 * Render a single step-config line. Returns `null` when the value is
 * absent (we omit the line entirely).
 */
function renderStepConfigLine(key: ChainWorkerSerializableField, value: unknown): string | null {
	if (value === undefined || value === null) return null;
	switch (key) {
		case "env": {
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			const entries = Object.entries(value as Record<string, string | null>).sort(([a], [b]) => a.localeCompare(b));
			return entries.length > 0 ? `env: ${JSON.stringify(Object.fromEntries(entries))}` : null;
		}
		case "artifact":
			if (value === false) return "artifact: false";
			if (typeof value === "string" && value.length > 0) return `artifact: ${value}`;
			return null;
		case "reads":
			if (value === false) return "reads: false";
			if (Array.isArray(value) && value.length > 0) return `reads: ${(value as string[]).join(", ")}`;
			return null;
		case "model":
			if (typeof value === "string" && value.length > 0) return `model: ${value}`;
			return null;
		case "thinking":
			if (value === false) return "thinking: false";
			if (typeof value === "string" && value.length > 0) return `thinking: ${value}`;
			return null;
		case "thinkingMin":
			if (value === false) return "thinkingMin: false";
			if (typeof value === "string" && value.length > 0) return `thinkingMin: ${value}`;
			return null;
		case "thinkingMax":
			if (value === false) return "thinkingMax: false";
			if (typeof value === "string" && value.length > 0) return `thinkingMax: ${value}`;
			return null;
		case "skills":
			if (value === false) return "skills: false";
			if (Array.isArray(value) && value.length > 0) return `skills: ${(value as string[]).join(", ")}`;
			return null;
		case "progress":
			if (typeof value !== "boolean") return null;
			return `progress: ${value ? "true" : "false"}`;

		default:
			return null;
	}
}
