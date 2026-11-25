declare module "node:fs" {
	export function readFileSync(path: string, encoding: string): string;
	export function writeFileSync(path: string, data: string): void;
	export function unlinkSync(path: string): void;
	export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
	export function existsSync(path: string): boolean;
	export function readdirSync(path: string): string[];
	export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
	export function statSync(path: string): { size: number; mtimeMs: number };
}

declare module "node:path" {
	export function join(...paths: string[]): string;
	export function resolve(...paths: string[]): string;
	export function relative(from: string, to: string): string;
	export function dirname(path: string): string;
	export function basename(path: string): string;
	export function isAbsolute(path: string): boolean;
	export const sep: string;
}

declare module "node:os" {
	export function homedir(): string;
	export function tmpdir(): string;
}

declare module "node:test" {
	type TestFn = (t?: unknown) => void | Promise<void>;
	export default function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
	interface Assert {
		(value: unknown, message?: string): asserts value;
		ok(value: unknown, message?: string): asserts value;
		equal(actual: unknown, expected: unknown, message?: string): void;
		notEqual(actual: unknown, expected: unknown, message?: string): void;
		deepEqual(actual: unknown, expected: unknown, message?: string): void;
		match(actual: string, expected: RegExp, message?: string): void;
		doesNotMatch(actual: string, expected: RegExp, message?: string): void;
	}
	const assert: Assert;
	export default assert;
}
