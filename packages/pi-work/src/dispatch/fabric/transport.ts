export const FABRIC_PROGRAM_RUN_EVENT = "pi-fabric:program:run:v1";

/** The optional host protocol is mirrored locally: pi-work never imports Fabric. */
export type FabricProgramRunReply =
	| { readonly ok: true; readonly program: string; readonly value: unknown; readonly logs: readonly string[] }
	| { readonly ok: false; readonly error: string; readonly program?: string };

export interface FabricProgramInput {
	readonly task: string;
	readonly name?: string | undefined;
	readonly model?: string | undefined;
	readonly thinking?: string | undefined;
	readonly cwd?: string | undefined;
	readonly worktree?: boolean | undefined;
	readonly writableRoots?: readonly string[] | undefined;
	readonly shell?: "unconfined" | undefined;
	readonly schema?: unknown;
	readonly systemPrompt?: string | undefined;
}

export interface FabricProgramRunRequest {
	readonly ref: string;
	readonly input: FabricProgramInput;
	readonly requirePromoted?: boolean | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly reply: (result: FabricProgramRunReply) => void;
}

export interface FabricProgramEventBus {
	emit(channel: string, data: unknown): void;
}

export type FabricTransportFindingCode = "fabric-unavailable" | "fabric-timeout" | "fabric-aborted" | "fabric-run-failed" | "fabric-emit-failed" | "fabric-request-invalid";
export type FabricTransportResult = Extract<FabricProgramRunReply, { ok: true }> | {
	readonly ok: false;
	readonly finding: { readonly code: FabricTransportFindingCode; readonly message: string };
};

export interface FabricTransportOptions {
	readonly ref: string;
	readonly input: FabricProgramInput;
	readonly requirePromoted?: boolean | undefined;
	readonly signal?: AbortSignal | undefined;
	/** Positive milliseconds, capped at ten minutes; default five minutes. */
	readonly timeoutMs?: number;
}

function failure(code: FabricTransportFindingCode, message: string): FabricTransportResult {
	return { ok: false, finding: { code, message } };
}

/** A silent listener and an absent listener are indistinguishable on Pi's bus. */
export function runFabricProgram(events: FabricProgramEventBus | undefined, options: FabricTransportOptions): Promise<FabricTransportResult> {
	const timeoutMs = options.timeoutMs ?? 300_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
		return Promise.resolve(failure("fabric-request-invalid", "Fabric reply timeout must be between 1 and 600000 milliseconds"));
	}
	if (options.signal?.aborted) return Promise.resolve(failure("fabric-aborted", "Fabric dispatch was aborted"));
	if (events === undefined) return Promise.resolve(failure("fabric-unavailable", "Fabric event bus is unavailable"));
	const supplied = options.input;
	// Copy only program-approved fields; never forward caller transport overrides.
	const input: FabricProgramInput = {
		task: supplied.task, name: supplied.name, model: supplied.model, thinking: supplied.thinking,
		cwd: supplied.cwd, worktree: supplied.worktree, writableRoots: supplied.writableRoots,
		shell: supplied.shell, schema: supplied.schema, systemPrompt: supplied.systemPrompt,
	};
	try {
		if (Buffer.byteLength(JSON.stringify(input), "utf8") > 64 * 1024) {
			return Promise.resolve(failure("fabric-request-invalid", "Fabric program input exceeds 64 KiB; pass the brief by path and hash"));
		}
	} catch (error) {
		return Promise.resolve(failure("fabric-request-invalid", String(error)));
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: FabricTransportResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			resolve(result);
		};
		const abort = () => finish(failure("fabric-aborted", "Fabric dispatch was aborted"));
		const timer = setTimeout(() => finish(failure("fabric-timeout", "Fabric did not reply within the bound; its listener may be absent")), timeoutMs);
		options.signal?.addEventListener("abort", abort, { once: true });
		const request: FabricProgramRunRequest = {
			ref: options.ref, input, requirePromoted: options.requirePromoted, signal: options.signal,
			reply: (result) => finish(result.ok
				? { ok: true, program: result.program, value: result.value, logs: result.logs }
				: failure("fabric-run-failed", result.error)),
		};
		try {
			events.emit(FABRIC_PROGRAM_RUN_EVENT, request);
		} catch (error) {
			finish(failure("fabric-emit-failed", String(error)));
		}
	});
}
