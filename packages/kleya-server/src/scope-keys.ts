// Which names a scope key may have (K3). Internal: not a package export.

/** `constructor`, `__proto__`, `toString`, `hasOwnProperty` and every other member of Object.prototype. */
const RESERVED: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * Throws when `key` names an Object.prototype member. Every plain object already answers to such a name, so a scope key
 * with one could read as set when it is not, or go unwritten, and `__proto__` would replace the scope's prototype.
 */
export function checkScopeKey(key: string, what: string): void {
	if (RESERVED.has(key)) throw new Error(`${what}: the scope key ${JSON.stringify(key)} names an Object.prototype member`);
}
