export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

export function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}

export function fail<T = never>(...errors: string[]): Result<T> {
	return { ok: false, errors };
}

/** A refusal the CLI reports with exit code 2 (bad input or a rule said no) rather than 1 (something broke). */
export class Refusal extends Error {
	override readonly name = "Refusal";
}
