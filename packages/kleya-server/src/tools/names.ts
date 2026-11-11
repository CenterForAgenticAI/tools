// Whether an argument or parameter key names a bound scope key (K3, K4-I6). Internal to ./tools; not a package
// export. It is its own module so the contract suite can count the guard's work without timing it.

/** 0: separator, 1: upper-case letter, 2: other letter or mark, 3: digit. */
function kindOf(c: string): number {
	if (/\p{Lu}|\p{Lt}/u.test(c)) return 1;
	if (/\p{L}|\p{M}/u.test(c)) return 2;
	if (/\p{N}/u.test(c)) return 3;
	return 0;
}

/**
 * A key's words, in one pass over its NFKC form (so full-width letters count as their ASCII twins): split at
 * separators, at lower-to-upper case, between letters and digits, and before the last capital of a capital run
 * followed by a lower-case letter ("HTMLParser"), then lowercased.
 */
export function words(key: string): string[] {
	const chars = [...key.normalize("NFKC")];
	const out: string[] = [];
	let word = "";
	for (let i = 0; i < chars.length; i++) {
		const k = kindOf(chars[i]!);
		if (k === 0) {
			if (word !== "") out.push(word);
			word = "";
			continue;
		}
		if (word !== "") {
			const p = kindOf(chars[i - 1]!);
			const next = i + 1 < chars.length ? kindOf(chars[i + 1]!) : 0;
			if ((p === 2 && k === 1) || (p === 3) !== (k === 3) || (p === 1 && k === 1 && next === 2)) {
				out.push(word);
				word = "";
			}
		}
		word += chars[i];
	}
	if (word !== "") out.push(word);
	return out.map((w) => w.toLowerCase());
}

/** What may follow a bound key's words in a key that names it: `tenants`, `tenantid`, `tenant_keys`. */
const SUFFIXES = ["", "s", "id", "ids", "key", "keys", "name", "names", "uuid"];
const LONGEST_SUFFIX = 4;

/**
 * The bound key `key` names: one whose words, joined, equal a run of `key`'s words joined, with an optional suffix.
 * Words, never substrings: `tenantId`, `tenant_ids` and `TENANTID` name `tenant`; `content` and `lieutenant`
 * do not.
 */
export function named(key: string, bound: readonly string[]): string | undefined {
	const have = words(key);
	return bound.find((b) => names(have, words(b).join("")));
}

/**
 * Whether a run of `have`, joined, is `want` plus a suffix. Linear in `have`'s length: a run starting at a word
 * stops once it is longer than `want` and the longest suffix, so each word is read a bounded number of times.
 */
export function names(have: readonly string[], want: string): boolean {
	if (want === "") return false;
	for (let i = 0; i < have.length; i++) {
		let run = "";
		for (let j = i; j < have.length && run.length <= want.length + LONGEST_SUFFIX; j++) {
			run += have[j];
			if (run.startsWith(want) && SUFFIXES.includes(run.slice(want.length))) return true;
		}
	}
	return false;
}
