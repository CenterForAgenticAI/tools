import type { AgentDefinition, Diagnostic, Isolation } from "./definition.ts";

export interface IsolationDowngradeGrant {
	readonly kind: "isolation-downgrade";
	readonly from: Isolation;
	readonly to: Isolation;
	readonly approvedBy: string;
	readonly reason?: string;
}

export interface IsolationRequest {
	readonly definition: Isolation;
	readonly requested: Isolation;
	readonly grant?: IsolationDowngradeGrant;
}

export type IsolationCheck =
	| { readonly ok: true; readonly isolation: Isolation; readonly grant?: IsolationDowngradeGrant }
	| { readonly ok: false; readonly reason: "requested-isolation-is-looser" };

const isolationRank: Readonly<Record<Isolation, number>> = { shared: 0, worktree: 1, ephemeral: 2 };

/** Check a caller's isolation choice against the definition's loosest allowed level. */
export function checkIsolation(request: IsolationRequest): IsolationCheck {
	if (isolationRank[request.requested] >= isolationRank[request.definition]) {
		return { ok: true, isolation: request.requested };
	}
	const grant = request.grant;
	if (
		grant?.kind === "isolation-downgrade" &&
		grant.from === request.definition &&
		grant.to === request.requested &&
		grant.approvedBy.trim().length > 0
	) {
		return { ok: true, isolation: request.requested, grant };
	}
	return { ok: false, reason: "requested-isolation-is-looser" };
}

export interface RuntimeAdapter {
	readonly runtime: string;
	readonly knownKeys: readonly string[];
}

export type RuntimeCheck = { readonly ok: true } | { readonly ok: false; readonly diagnostics: Diagnostic[] };

/** Check required runtime identity and the selected adapter's understood options. */
export function checkRuntime(definition: AgentDefinition, adapter: RuntimeAdapter): RuntimeCheck {
	const diagnostics: Diagnostic[] = [];
	for (const [runtime, block] of Object.entries(definition.runtimes)) {
		if (runtime !== adapter.runtime && block.required === true) {
			diagnostics.push({
				severity: "error",
				code: "runtime-required",
				path: `runtimes.${runtime}.required`,
				message: `The definition requires runtime "${runtime}", not "${adapter.runtime}".`,
			});
		}
	}
	const selected = definition.runtimes[adapter.runtime];
	if (selected) {
		const known = new Set(adapter.knownKeys);
		for (const key of Object.keys(selected)) {
			if (key !== "required" && !known.has(key)) {
				diagnostics.push({
					severity: "error",
					code: "runtime-key-unknown",
					path: `runtimes.${adapter.runtime}.${key}`,
					message: `Runtime "${adapter.runtime}" does not recognise the option "${key}".`,
				});
			}
		}
	}
	return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}
