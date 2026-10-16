/**
 * Simple relative globs for `sync.include` and `sync.exclude` in
 * profile.json. `/` separates segments; `*` matches any run of characters
 * inside one segment, `?` one character, and a `**` segment any number of
 * segments. None of the three matches a name that starts with a dot: write
 * the dot. A pattern that matches a directory also covers everything below
 * it. Patterns are relative to the profile directory and never contain `..`.
 *
 * Matching is linear: a segment is matched with two pointers that back up
 * only to the last `*`, and a path is matched by stepping a set of pattern
 * positions forward one segment at a time, so no name or depth can make a
 * pattern backtrack (patterns may come from another device, and names from
 * third-party skill repositories).
 */

const CONTROL = /[\p{Cc}\p{Cf}]/u;

function trimSlash(p: string): string {
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export type PatternKind = "include" | "exclude";

/**
 * Why `p` is not an acceptable pattern, or `undefined` when it is. An include
 * pattern must start with a literal name: `*`, `**` or `?` in the first
 * segment would class the whole profile root as config.
 */
export function patternProblem(p: string, kind: PatternKind): string | undefined {
	if (p.length === 0) return "must be a non-empty string";
	if (CONTROL.test(p)) return "must not contain control or format characters";
	if (p.includes("\\")) return "must use / as the separator";
	if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return "must be relative to the profile directory";
	if (p.includes("..")) return "must not contain ..";
	const segs = trimSlash(p).split("/");
	if (segs.some((s) => s === "" || s === ".")) return "must not have empty or . segments";
	if (kind === "include" && /[*?]/.test(segs[0] ?? "")) return "must start with a literal name, not a wildcard";
	return undefined;
}

export type Pattern = readonly string[];

/** Split into segments; a run of `**` segments is one `**`. */
export function compilePattern(p: string): Pattern {
	const out: string[] = [];
	for (const s of trimSlash(p).split("/")) if (!(s === "**" && out[out.length - 1] === "**")) out.push(s);
	return out;
}

/** Whether the segment pattern `pat` (`*`, `?`, literals) matches the whole of `name`. At worst len(pat) × len(name) steps, never exponential. */
export function segmentMatches(pat: string, name: string): boolean {
	const p = [...pat];
	const n = [...name];
	if (n[0] === "." && p[0] !== ".") return false;
	let i = 0;
	let j = 0;
	let star = -1;
	let mark = 0;
	while (j < n.length) {
		if (i < p.length && p[i] !== "*" && (p[i] === "?" || p[i] === n[j])) {
			i++;
			j++;
		} else if (i < p.length && p[i] === "*") {
			star = i++;
			mark = j;
		} else if (star >= 0) {
			i = star + 1;
			j = ++mark;
		} else return false;
	}
	while (i < p.length && p[i] === "*") i++;
	return i === p.length;
}

/** Add `**` skips: a position at `**` may also stand after it. */
function close(p: Pattern, at: boolean[]): boolean[] {
	for (let i = 0; i < p.length; i++) if (at[i] === true && p[i] === "**") at[i + 1] = true;
	return at;
}

/** Whether `p` matches the path `segs` or one of its ancestors. */
export function covers(p: Pattern, segs: readonly string[]): boolean {
	let at = close(p, [true]);
	for (const seg of segs) {
		const next: boolean[] = [];
		let any = false;
		for (let i = 0; i < p.length; i++) {
			if (at[i] !== true) continue;
			const head = p[i] as string;
			if (head === "**") {
				if (!seg.startsWith(".")) next[i] = any = true;
			} else if (segmentMatches(head, seg)) next[i + 1] = any = true;
		}
		if (!any) return false;
		at = close(p, next);
		if (at[p.length] === true) return true;
	}
	return false;
}

/** Whether `p` could match some path strictly below the directory `dir`. */
export function mayMatchBelow(p: Pattern, dir: readonly string[]): boolean {
	let i = 0;
	for (const seg of dir) {
		if (i === p.length) return false;
		const head = p[i] as string;
		if (head === "**") return true;
		if (!segmentMatches(head, seg)) return false;
		i++;
	}
	return i < p.length;
}
