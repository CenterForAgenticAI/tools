import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfig } from "../src/core/config.ts";
import { Refusal } from "../src/core/result.ts";
import { expectedSessionDir, storeChoice } from "../src/core/storechoice.ts";
import { portableProfile, portableSettings, renderProfile, renderSettings, sessionDirFor, tokenHost, type Json, type TokenHost } from "../src/core/tokens.ts";

const A: TokenHost = { home: "/home/alice", codeRoot: "/home/alice/Code" };
const B: TokenHost = { home: "/Users/sam", codeRoot: "/srv/code" };
const A_SESSIONS = "/mnt/a/sessions";
const B_SESSIONS = "/Volumes/s";

/** A settings.json as it sits on host A. */
const local: Json = {
	theme: "dark",
	sessionDir: A_SESSIONS,
	packages: ["/home/alice/Code/caair/pi/x", "npm:foo", { source: "/home/alice/.pi/pkg" }],
	extensions: { key: "/home/alice/.config/x" },
	n: 3,
	b: true,
	z: null,
	home: "/home/alice",
	code: "/home/alice/Code",
};

function own(o: Json, key: string): unknown {
	return Object.getOwnPropertyDescriptor(o as object, key)?.value;
}

function refusal(pattern: RegExp): (e: unknown) => boolean {
	return (e: unknown) => e instanceof Refusal && pattern.test(e.message);
}

describe("portable", () => {
	it("replaces whole path prefixes in string values, preferring the longer root", () => {
		const { json, warnings } = portableSettings(local, A);
		assert.deepEqual(json, {
			theme: "dark",
			packages: ["${CODE}/caair/pi/x", "npm:foo", { source: "${HOME}/.pi/pkg" }],
			extensions: { key: "${HOME}/.config/x" },
			n: 3,
			b: true,
			z: null,
			home: "${HOME}",
			code: "${CODE}",
		});
		assert.deepEqual(warnings, []);
	});
	it("tokenises a top-level string", () => {
		assert.deepEqual(portableSettings("/home/alice/x", A), { json: "${HOME}/x", warnings: [] });
		assert.deepEqual(portableProfile("/home/alice/Code", A), { json: "${CODE}", warnings: [] });
	});
	it("never replaces inside a longer name", () => {
		assert.deepEqual(portableSettings({ a: "/home/alice2/x", b: "/home/alice2", c: "/home/alicetmas", d: "/home/alice/Codex/y" }, A), {
			json: { a: "/home/alice2/x", b: "/home/alice2", c: "/home/alicetmas", d: "${HOME}/Codex/y" },
			warnings: [],
		});
	});
	it("gives ${CODE} for a code root outside home", () => {
		assert.deepEqual(portableSettings(["/srv/code/a", "/Users/sam/a"], B).json, ["${CODE}/a", "${HOME}/a"]);
	});
	it("settings drop a top-level sessionDir only; profile keeps it", () => {
		const input: Json = { sessionDir: A_SESSIONS, nested: { sessionDir: "/home/alice/s" } };
		assert.deepEqual(portableSettings(input, A).json, { nested: { sessionDir: "${HOME}/s" } });
		assert.deepEqual(portableProfile(input, A).json, { sessionDir: A_SESSIONS, nested: { sessionDir: "${HOME}/s" } });
	});
	it("keeps a literal token as written and reports it", () => {
		const { json, warnings } = portableSettings({ env: { A: "${HOME}/x" } }, A);
		assert.deepEqual(json, { env: { A: "${HOME}/x" } });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /^env\.A: .*\$\{HOME\}/);
	});
	it("refuses a known token followed by a Windows-style separator, as render does", () => {
		assert.throws(() => portableSettings({ a: "${HOME}\\x" }, A), refusal(/^a: \$\{HOME\} is followed by a Windows-style separator/));
		assert.throws(() => portableProfile(["${CODE}\\x"], A), refusal(/^\[0\]: \$\{CODE\}/));
		assert.throws(() => portableSettings("${HOME}\\x", A), refusal(/^\(top level\): /));
		assert.deepEqual(portableSettings({ a: "${USER}\\x" }, A).json, { a: "${USER}\\x" });
	});
	it("keeps a __proto__ key as an own key, never as the prototype", () => {
		const out = portableSettings(JSON.parse('{"__proto__":"/home/alice/x"}') as Json, A).json;
		assert.equal(Object.getPrototypeOf(out), Object.prototype);
		assert.deepEqual(Object.keys(out as object), ["__proto__"]);
		assert.equal(own(out, "__proto__"), "${HOME}/x");
	});
	it("does not change its input", () => {
		const input = JSON.parse(JSON.stringify(local)) as Json;
		portableSettings(input, A);
		portableProfile(input, A);
		assert.deepEqual(input, local);
	});
});

describe("portable reports host paths it leaves as written", () => {
	it("warns, by JSON path, for a root after the start of a value or in a key, and changes nothing", () => {
		const input: Json = { f: "--flag=/home/alice/x", P: "a:/home/alice/b", u: "file:///home/alice/Code/x", k: { "/home/alice/k": 1 } };
		const { json, warnings } = portableSettings(input, A);
		assert.deepEqual(json, input);
		assert.deepEqual(
			warnings.map((w) => w.slice(0, w.indexOf(":", w.startsWith("k[") ? w.indexOf("]") : 0))),
			["f", "P", "u", 'k["/home/alice/k"]'],
		);
		assert.match(warnings[0] ?? "", /\$\{HOME\}.*kept as written/);
		assert.match(warnings[2] ?? "", /\$\{CODE\} and \$\{HOME\}/);
		assert.match(warnings[3] ?? "", /key holds this host's path for \$\{HOME\}/);
	});
	it("warns for a later root in a value whose start is tokenised", () => {
		const { json, warnings } = portableSettings({ p: "/home/alice/bin:/home/alice/Code/x" }, A);
		assert.deepEqual(json, { p: "${HOME}/bin:/home/alice/Code/x" });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /^p: /);
	});
	it("warns for a root followed by a backslash, at any position", () => {
		const { json, warnings } = portableSettings({ a: "/home/alice\\x", b: "x=/home/alice\\y" }, A);
		assert.deepEqual(json, { a: "/home/alice\\x", b: "x=/home/alice\\y" });
		assert.deepEqual(
			warnings.map((w) => w.slice(0, 2)),
			["a:", "b:"],
		);
	});
	it("warns for a top-level string", () => {
		const { warnings } = portableProfile("x=/home/alice", A);
		assert.match(warnings[0] ?? "", /^\(top level\): /);
	});
	it("stays quiet for a root at the start, inside a longer name, or a plain Windows path", () => {
		assert.deepEqual(portableSettings({ a: "/home/alice/x", b: "x/home/alice2", c: "y/home/alicetmas/z", d: "C:\\Users\\alice", k: { alice: 1, "/home/alicex": 2 } }, A).warnings, []);
	});
});

describe("render", () => {
	it("renderSettings expands tokens and sets sessionDir from its argument", () => {
		const { json, warnings } = renderSettings({ a: "${HOME}/x", b: "${CODE}", c: ["${CODE}/y"], sessionDir: "/elsewhere" }, B, B_SESSIONS);
		assert.deepEqual(json, { a: "/Users/sam/x", b: "/srv/code", c: ["/srv/code/y"], sessionDir: B_SESSIONS });
		assert.deepEqual(warnings, []);
	});
	it("renderSettings removes sessionDir when given none", () => {
		assert.deepEqual(renderSettings({ sessionDir: "/x", a: 1 }, A, undefined).json, { a: 1 });
	});
	it("renderProfile never adds or removes sessionDir", () => {
		assert.deepEqual(renderProfile({ sessionStore: "main" }, A).json, { sessionStore: "main" });
		assert.deepEqual(renderProfile({ sessionDir: "${HOME}/s" }, A).json, { sessionDir: "/home/alice/s" });
	});
	it("the type checker makes the settings choice explicit", () => {
		// @ts-expect-error renderSettings needs the session directory, even when it is undefined.
		assert.deepEqual(renderSettings({ sessionDir: "/x" }, A).json, {});
		// @ts-expect-error renderProfile takes no session directory.
		assert.deepEqual(renderProfile({}, A, "/mnt/s").json, {});
	});
	it("leaves an unknown or misplaced token unchanged and reports it", () => {
		const { json, warnings } = renderSettings({ a: "${USER}/x", b: "/opt/${HOME}", c: "${HOME}x", d: "${CODE}/${NOPE}" }, A, undefined);
		assert.deepEqual(json, { a: "${USER}/x", b: "/opt/${HOME}", c: "${HOME}x", d: "/home/alice/Code/${NOPE}" });
		assert.equal(warnings.length, 4);
		assert.match(warnings[0] ?? "", /^a: unknown token \$\{USER\}/);
		assert.match(warnings[1] ?? "", /^b: \$\{HOME\} is not a whole path prefix/);
		assert.match(warnings[2] ?? "", /^c: \$\{HOME\} is not a whole path prefix/);
		assert.match(warnings[3] ?? "", /^d: unknown token \$\{NOPE\}/);
	});
	it("refuses a token followed by a Windows-style separator", () => {
		assert.throws(() => renderSettings({ a: "${HOME}\\x" }, A, undefined), refusal(/^a: \$\{HOME\}.*Windows/));
		assert.throws(() => renderProfile(["${CODE}\\x"], A), Refusal);
		assert.throws(() => renderProfile("${HOME}\\x", A), refusal(/^\(top level\): /));
	});
	it("expands a top-level string", () => {
		assert.deepEqual(renderProfile("${CODE}/x", B), { json: "/srv/code/x", warnings: [] });
	});
	it("warns when this host would sync an expanded value back differently", () => {
		const { json, warnings } = renderSettings({ a: "${HOME}/Code/x", b: "${CODE}/x", c: "${HOME}/y" }, A, undefined);
		assert.deepEqual(json, { a: "/home/alice/Code/x", b: "/home/alice/Code/x", c: "/home/alice/y" });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /^a: this host syncs the expanded path back as \$\{CODE\}\/x/);
	});
	it("keeps a __proto__ key as an own key", () => {
		const out = renderProfile(JSON.parse('{"__proto__":"${HOME}/x"}') as Json, A).json;
		assert.equal(Object.getPrototypeOf(out), Object.prototype);
		assert.equal(own(out, "__proto__"), "/home/alice/x");
	});
});

describe("host roots", () => {
	const bad: Array<[string, Partial<TokenHost>]> = [
		["Windows home", { home: "C:\\Users\\cg" }],
		["backslash code root", { codeRoot: "/home/alice\\Code" }],
		["drive-letter code root", { codeRoot: "C:/Code" }],
		["relative home", { home: "home/alice" }],
		["trailing slash", { home: "/home/alice/" }],
		["dot segments", { codeRoot: "/home/alice/../Code" }],
		["file-system root", { home: "/" }],
	];
	for (const [what, change] of bad) {
		it(`refuses a ${what}`, () => {
			const host = { ...A, ...change };
			assert.throws(() => portableSettings({}, host), Refusal);
			assert.throws(() => portableProfile({}, host), Refusal);
			assert.throws(() => renderSettings({}, host, undefined), Refusal);
			assert.throws(() => renderProfile({}, host), Refusal);
		});
	}
	for (const dir of ["sessions", "C:\\s", "/mnt/../s", "/mnt//s", "/mnt/./s", "/mnt/s\n"]) {
		it(`renderSettings refuses the session directory ${JSON.stringify(dir)}`, () => {
			assert.throws(() => renderSettings({}, A, dir), refusal(/session directory must be an absolute, normalised POSIX path/));
		});
	}
	it("handles roots with regular-expression metacharacters as plain text", () => {
		const odd: TokenHost = { home: "/home/c.h$&r*is(1)", codeRoot: "/srv/[code]+$1" };
		const input: Json = { a: "/home/c.h$&r*is(1)/x", b: "/srv/[code]+$1", c: "/home/cXh$&r*is(1)/x", d: "/srv/[code]+$1x", e: "/srv/code/x" };
		const p = portableSettings(input, odd);
		assert.deepEqual(p, { json: { a: "${HOME}/x", b: "${CODE}", c: "/home/cXh$&r*is(1)/x", d: "/srv/[code]+$1x", e: "/srv/code/x" }, warnings: [] });
		assert.deepEqual(renderSettings(p.json, odd, undefined), { json: input, warnings: [] });
	});
});

describe("portable never keeps what render refuses", () => {
	const corpus = ["${HOME}\\x", "${CODE}\\", "${HOME}", "${HOME}/", "${HOME}/a\\b", "${HOME}x", "x${HOME}\\y", "${USER}\\x", "${NOPE}/x", "${HOME}${CODE}", "/home/alice\\x", "/home/alice/x", "/home/alice/Code\\x", "/srv/code\\x", "/Users/sam", "C:\\Users\\x", "\\\\server\\share", "$HOME/x", "${HOME", "", "/", "\\"];
	const hosts: TokenHost[] = [A, B, { home: "/h", codeRoot: "/h" }, { home: "/srv/code/me", codeRoot: "/srv/code" }];
	it("for every value and host in a fixed corpus", () => {
		let refused = 0;
		for (const host of hosts) {
			for (const value of corpus) {
				for (const shape of [value, [value], { k: { v: value } }] as Json[]) {
					for (const port of [portableSettings, portableProfile]) {
						let out: Json;
						try {
							out = port(shape, host).json;
						} catch (error) {
							assert.ok(error instanceof Refusal);
							refused++;
							continue;
						}
						for (const other of hosts) {
							assert.doesNotThrow(() => renderSettings(out, other, undefined), `${JSON.stringify(value)} on ${other.home}`);
							assert.doesNotThrow(() => renderProfile(out, other), `${JSON.stringify(value)} on ${other.home}`);
						}
					}
				}
			}
		}
		// Two corpus values start with a known token and "\": 2 values x 4 hosts x 3 shapes x 2 forms.
		assert.equal(refused, 48);
	});
});

describe("round trip", () => {
	it("render(portable(x, A), A) equals x, with sessionDir from the caller", () => {
		assert.deepEqual(renderSettings(portableSettings(local, A).json, A, A_SESSIONS).json, local);
		const { sessionDir: _dropped, ...rest } = local as Record<string, Json>;
		assert.deepEqual(renderSettings(portableSettings(local, A).json, A, undefined).json, rest);
	});
	it("A -> B -> A is stable", () => {
		const p = portableSettings(local, A).json;
		const onB = renderSettings(p, B, B_SESSIONS);
		assert.deepEqual(onB.warnings, []);
		assert.equal(own(onB.json, "code"), "/srv/code");
		assert.equal(own(onB.json, "sessionDir"), B_SESSIONS);
		assert.deepEqual(portableSettings(onB.json, B).json, p);
		assert.deepEqual(renderSettings(portableSettings(onB.json, B).json, A, A_SESSIONS).json, local);
	});
	it("B -> A -> B keeps stable values and reports the one that drifts", () => {
		const onB: Json = { code: "/srv/code/x", home: "/Users/sam/y", homeCode: "/Users/sam/Code/z" };
		const p = portableSettings(onB, B).json;
		assert.deepEqual(p, { code: "${CODE}/x", home: "${HOME}/y", homeCode: "${HOME}/Code/z" });
		const onA = renderSettings(p, A, undefined);
		assert.deepEqual(onA.json, { code: "/home/alice/Code/x", home: "/home/alice/y", homeCode: "/home/alice/Code/z" });
		assert.equal(onA.warnings.length, 1);
		assert.match(onA.warnings[0] ?? "", /^homeCode: .*\$\{CODE\}\/z/);
		const back = renderSettings(portableSettings(onA.json, A).json, B, undefined).json;
		assert.deepEqual(back, { code: "/srv/code/x", home: "/Users/sam/y", homeCode: "/srv/code/z" });
	});
	it("documents the ambiguity: a literal ${HOME} in a local file expands after a round trip", () => {
		assert.deepEqual(renderSettings(portableSettings({ a: "${HOME}/lit" }, A).json, A, undefined).json, { a: "/home/alice/lit" });
	});
	it("documents the ambiguity: a literal path to host B on host A is tokenised on host B", () => {
		const p = portableSettings({ a: "/Users/sam/x" }, A).json;
		assert.deepEqual(p, { a: "/Users/sam/x" });
		assert.deepEqual(portableSettings(renderSettings(p, B, undefined).json, B).json, { a: "${HOME}/x" });
	});
	it("when the code root equals home, ${HOME} wins", () => {
		assert.deepEqual(portableSettings({ a: "/h/x" }, { home: "/h", codeRoot: "/h" }).json, { a: "${HOME}/x" });
	});
	it("a code root that is a parent of home: the longer root wins and both round trip", () => {
		const host: TokenHost = { home: "/srv/code/me", codeRoot: "/srv/code" };
		const input: Json = { a: "/srv/code/me/x", b: "/srv/code/y", c: "/srv/code", d: "/srv/code/me" };
		const p = portableSettings(input, host);
		assert.deepEqual(p, { json: { a: "${HOME}/x", b: "${CODE}/y", c: "${CODE}", d: "${HOME}" }, warnings: [] });
		assert.deepEqual(renderSettings(p.json, host, undefined), { json: input, warnings: [] });
		const drift = renderSettings({ a: "${CODE}/me/x" }, host, undefined);
		assert.match(drift.warnings[0] ?? "", /^a: .*back as \$\{HOME\}\/x/);
	});
});

describe("sessionDir comes from the profile's own session store", () => {
	const config = parseConfig({ schemaVersion: 1, hostId: "box", sessionStores: { main: { path: "/mnt/main" }, other: { path: "/mnt/other" } }, defaultSessionStore: "main" });
	it("a profile using its own folder gets none, whatever the default store", () => {
		assert.equal(sessionDirFor({ sessions: { store: "profile" } }, config), undefined);
	});
	it("a profile without sessions.store gets none", () => {
		assert.equal(sessionDirFor({}, config), undefined);
	});
	it("a profile naming a store gets that store's path, not the default's", () => {
		assert.equal(sessionDirFor({ sessions: { store: "other" } }, config), "/mnt/other");
	});
	it("refuses a store this host does not define, or one on the object prototype", () => {
		assert.throws(() => sessionDirFor({ sessions: { store: "gone" } }, config), refusal(/unknown session store: gone/));
		assert.throws(() => sessionDirFor({ sessions: { store: "constructor" } }, config), refusal(/unknown session store: constructor/));
	});
	it("storeChoice is the rule doctor uses", () => {
		assert.deepEqual(storeChoice({}, config), { kind: "unset" });
		assert.deepEqual(storeChoice({ sessions: { store: "profile" } }, config), { kind: "profile" });
		assert.deepEqual(storeChoice({ sessions: { store: "main" } }, undefined), { kind: "unknown", id: "main" });
		assert.equal(expectedSessionDir(storeChoice({ sessions: { store: "main" } }, config)), "/mnt/main");
	});
});

describe("codeRoot in machine config", () => {
	const base = { schemaVersion: 1, hostId: "box", sessionStores: { main: { path: "/mnt/s" } } };
	it("accepts an absolute, normalised path", () => {
		assert.equal(parseConfig({ ...base, codeRoot: "/srv/code" }).codeRoot, "/srv/code");
		assert.equal("codeRoot" in parseConfig(base), false);
	});
	for (const bad of ["code", "/srv/code/", "/srv/../code", "C:\\code", "/srv\\code", "/", "", 3]) {
		it(`refuses codeRoot ${JSON.stringify(bad)}`, () => {
			assert.throws(() => parseConfig({ ...base, codeRoot: bad }), refusal(/codeRoot must be an absolute, normalised path/));
		});
	}
	it("tokenHost defaults the code root to <home>/Code and never sets a session directory", () => {
		assert.deepEqual(tokenHost(parseConfig({ ...base, defaultSessionStore: "main" }), "/home/me"), { host: { home: "/home/me", codeRoot: "/home/me/Code" }, warnings: [] });
		assert.deepEqual(tokenHost(parseConfig({ ...base, codeRoot: "/srv/code" }), "/home/me"), { host: { home: "/home/me", codeRoot: "/srv/code" }, warnings: [] });
	});
	for (const codeRoot of ["/home/me", "/home"]) {
		it(`tokenHost warns when codeRoot ${codeRoot} is home or a parent of it`, () => {
			const { warnings } = tokenHost(parseConfig({ ...base, codeRoot }), "/home/me");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /^codeRoot is the home directory or a parent of it/);
		});
	}
	it("tokenHost stays quiet for a code root that only shares a name prefix with home", () => {
		assert.deepEqual(tokenHost(parseConfig({ ...base, codeRoot: "/home/m" }), "/home/me").warnings, []);
	});
});
