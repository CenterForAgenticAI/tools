import {
	createReadToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerDelegateOnlyEvent } from "./on-guard.js";
import type { DelegateOnlyRuntime } from "./runtime-state.js";

type ReadDefinition = ReturnType<typeof createReadToolDefinition>;
type ReadParams = Parameters<ReadDefinition["execute"]>[1];
type ReadContext = Parameters<ReadDefinition["execute"]>[4];
type ReadSignal = Parameters<ReadDefinition["execute"]>[2];
type ReadUpdate = Parameters<ReadDefinition["execute"]>[3];
type ReadResult = Awaited<ReturnType<ReadDefinition["execute"]>>;

const DELEGATE_ONLY_PREFIX = "[delegate-only:";

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
	const source = Buffer.from(text, "utf8");
	if (source.byteLength <= maxBytes) return { text, bytes: source.byteLength, truncated: false };

	let end = Math.max(0, Math.min(maxBytes, source.byteLength));
	while (end > 0) {
		let start = end - 1;
		while (start >= 0 && (source[start] & 0xc0) === 0x80) start--;
		if (start < 0) {
			end = 0;
			break;
		}
		const lead = source[start];
		const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
		if (start + width <= end) break;
		end = start;
	}

	const result = source.subarray(0, end).toString("utf8");
	return { text: result, bytes: end, truncated: true };
}

function continuationOffset(params: ReadParams, prefix: string): number {
	const start = typeof params.offset === "number" && Number.isFinite(params.offset) && params.offset > 0
		? Math.floor(params.offset)
		: 1;
	const completedLines = prefix.split("\n").length - 1;
	return start + completedLines;
}

function budgetNotice(budget: number): ReadResult {
	return {
		content: [{
			type: "text",
			text: `${DELEGATE_ONLY_PREFIX} read budget exhausted; 0 bytes remain of the ${budget}-byte per-turn budget]`,
		}],
		details: undefined,
	};
}

interface CappedResult {
	result: ReadResult;
	exposedBytes: number;
}

function capResult(result: ReadResult, params: ReadParams, maxBytes: number): CappedResult {
	const textParts = result.content.filter((part) => part.type === "text");
	const hasImage = result.content.some((part) => part.type === "image");
	const transformed: ReadResult["content"] = [];
	let remaining = maxBytes;
	let exposedBytes = 0;
	let truncated = false;

	for (const part of textParts) {
		if (truncated) break;
		const capped = truncateUtf8(part.text, remaining);
		transformed.push({ type: "text", text: capped.text });
		exposedBytes += capped.bytes;
		remaining -= capped.bytes;
		if (capped.truncated) {
			truncated = true;
			const nextOffset = continuationOffset(params, capped.text);
			const notice = `\n\n${DELEGATE_ONLY_PREFIX} truncated at ${exposedBytes} bytes; re-read with offset=${nextOffset} to continue]`;
			const last = transformed.at(-1);
			if (last?.type === "text") {
				transformed[transformed.length - 1] = { ...last, text: last.text + notice };
			} else {
				transformed.push({ type: "text", text: notice });
			}
		}
	}

	if (hasImage) {
		const notice = `${DELEGATE_ONLY_PREFIX} image output omitted because delegate-only read is capped]`;
		const last = transformed.at(-1);
		if (last?.type === "text") {
			transformed[transformed.length - 1] = { ...last, text: `${last.text}\n\n${notice}` };
		} else {
			transformed.push({ type: "text", text: notice });
		}
	}
	if (transformed.length === 0) return { result, exposedBytes: 0 };

	// Keep the built-in content block structure and details unchanged when the
	// result fits. The byte count is still charged to the current turn.
	return { result: { ...result, content: transformed }, exposedBytes };
}

export function registerCappedRead(pi: ExtensionAPI, runtime: DelegateOnlyRuntime): void {
	const builtin = createReadToolDefinition(process.cwd());
	let bytesReadThisTurn = 0;
	let activeReadQueue = Promise.resolve();
	let registered = false;

	registerDelegateOnlyEvent(pi, "turn_start", () => {
		bytesReadThisTurn = 0;
	});

	const definition = {
		...builtin,
		async execute(
			toolCallId: string,
			params: ReadParams,
			signal: ReadSignal,
			onUpdate: ReadUpdate,
			ctx: ReadContext,
		): Promise<ReadResult> {
			const normalRead = createReadToolDefinition(ctx.cwd);
			if (!runtime.getMode().active) return normalRead.execute(toolCallId, params, signal, onUpdate, ctx);

			const run = async (): Promise<ReadResult> => {
				const mode = runtime.getMode();
				if (!mode.active) return normalRead.execute(toolCallId, params, signal, onUpdate, ctx);
				const perCallCap = Math.max(0, Math.floor(mode.config.readBytesPerCall));
				const perTurnCap = Math.max(0, Math.floor(mode.config.readBytesPerTurn));
				const remainingTurnBudget = Math.max(0, perTurnCap - bytesReadThisTurn);
				if (remainingTurnBudget === 0) return budgetNotice(perTurnCap);
				if (perCallCap === 0) {
					return {
						content: [{ type: "text", text: `${DELEGATE_ONLY_PREFIX} read cap is 0 bytes per call; no content returned]` }],
						details: undefined,
					};
				}

				const result = await normalRead.execute(toolCallId, params, signal, onUpdate, ctx);
				const capped = capResult(result, params, Math.min(perCallCap, remainingTurnBudget));
				bytesReadThisTurn += capped.exposedBytes;
				return capped.result;
			};

			const queued = activeReadQueue.then(run, run);
			activeReadQueue = queued.then(() => undefined, () => undefined);
			return queued;
		},
	};

	// Claim the `read` tool name only once delegate-only mode actually engages.
	// Registering eagerly would shadow the built-in read for the entire session and
	// collide at load time with any other extension that also overrides `read`: Pi's
	// conflict detector rejects two extensions owning the same tool name, and the
	// rejection drops the whole losing extension, not just its `read`. Pi supports
	// late registration, so defer until the first activation via the --delegate-only
	// flag (session_start) or the /delegate-only command. When mode never engages the
	// built-in read stays in place, which is byte-for-byte what the inactive
	// pass-through produced anyway.
	const registerOnce = (): void => {
		if (registered) return;
		registered = true;
		pi.registerTool(definition);
	};

	if (runtime.getMode().active) {
		registerOnce();
		return;
	}
	const unsubscribe = runtime.subscribe((mode) => {
		if (!mode.active) return;
		registerOnce();
		unsubscribe();
	});
}
