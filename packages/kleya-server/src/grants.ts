// @centerforagenticai/kleya-server/grants: session grants (spec 5.3.1) and authorize() (5.3.3), ported from the S2 spike.
// WebCrypto and web globals only (atob, btoa, TextEncoder, crypto.subtle): it imports nothing, so the same file runs
// on Node, in workerd and in browsers. A product verifies grants on its own API with it, and mints them.
//
// Lines between `// @check NAME` and `// @end` are the safeguards the S2 mutation script
// (conformance/suites/s2/mutate.ts) removes or replaces one at a time. Keep each marker pair around the smallest
// statement that enforces one rule.

export type Role = "viewer" | "participant" | "owner";
export const ROLES: readonly Role[] = Object.freeze(["viewer", "participant", "owner"]);

/**
 * The rights each role stands for (5.3.3): a viewer reads; a participant and an owner also submit, steer and cancel.
 * A grant names a role or lists its rights directly, never both. Kleya's own rights are `read`, `submit`, `steer` and
 * `cancel`; any other right is the product's, and only the product's API gives it a meaning.
 */
export const ROLE_RIGHTS: Readonly<Record<Role, readonly string[]>> = Object.freeze({
	viewer: Object.freeze(["read"]),
	participant: Object.freeze(["read", "submit", "steer", "cancel"]),
	owner: Object.freeze(["read", "submit", "steer", "cancel"]),
});

/**
 * The claims an issuer (a product) signs. `ten` is the tenant and `hid` the session's harness id. Exactly one of
 * `role` and `rights` is set.
 */
export type GrantClaims = {
	readonly iss: string;
	readonly aud: string;
	readonly sub: string;
	readonly ten: string;
	readonly hid: string;
	readonly role?: Role;
	readonly rights?: readonly string[];
	readonly name?: string;
	readonly exp: number;
	readonly iat: number;
	readonly jti: string;
};

/** What a verifier stamps on a caller after verifying a grant: JSON, so a transport can forward it. */
export type GrantPrincipal = {
	readonly kind: "grant";
	readonly iss: string;
	readonly sub: string;
	readonly ten: string;
	readonly hid: string;
	readonly role?: Role;
	/** The role's rights, or the rights the grant listed. */
	readonly rights: readonly string[];
	readonly name?: string;
	readonly jti: string;
	readonly exp: number;
};

/** The verifier's own record of a session: never taken from a grant. */
export type HarnessRecord = { readonly tenant: string; readonly issuer: string };

export type HarnessDirectory = { get(hid: string): HarnessRecord | undefined };

/** A key in JWK form, as an issuer publishes it. Only Ed25519 (`kty: OKP`, `crv: Ed25519`). */
export type PublicJwk = {
	readonly kty: string;
	readonly crv?: string;
	readonly x?: string;
	readonly d?: string;
	readonly kid?: string;
	readonly alg?: string;
	readonly use?: string;
	readonly key_ops?: readonly string[];
};

export type IssuerKey = {
	readonly issuer: string;
	readonly kid: string;
	readonly key: CryptoKey;
	/** The raw 32-byte public key. Public, kept for diagnostics only. */
	readonly raw: Uint8Array<ArrayBuffer>;
};

export const GRANT_TYP = "kleya-grant+jwt";
/** Longest `exp - iat` a grant may have, in seconds: grants are short-lived (D15). */
export const MAX_LIFETIME_SECONDS = 900;
const LEEWAY_SECONDS = 5;
const MAX_TOKEN_CHARS = 4096;
const MAX_CLAIM_CHARS = 256;
const MAX_RIGHTS = 32;
const RIGHT = /^[a-z][a-z0-9_.:-]{0,63}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
	if (!B64URL.test(text) || text.length % 4 === 1) throw new TypeError("not base64url");
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encodeJson = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Public keys of every issuer a verifier trusts, one set per issuer, looked up by `(iss, kid)`.
 * `setIssuerKeys` replaces an issuer's whole set: publish the new key next to the old one, then drop the old one.
 */
export class IssuerKeyStore {
	readonly #issuers = new Map<string, Map<string, IssuerKey>>();

	async setIssuerKeys(issuer: string, jwks: { readonly keys: readonly PublicJwk[] }): Promise<void> {
		const set = new Map<string, IssuerKey>();
		for (const jwk of jwks.keys) {
			const entry = await importIssuerKey(issuer, jwk);
			if (set.has(entry.kid)) throw new Error(`duplicate kid ${entry.kid} for issuer ${issuer}`);
			set.set(entry.kid, entry);
		}
		this.#issuers.set(issuer, set);
	}

	removeIssuer(issuer: string): void {
		this.#issuers.delete(issuer);
	}

	/** The key `kid` of `issuer` only; a kid of another issuer never matches. */
	get(issuer: string, kid: string): IssuerKey | undefined {
		// @check V_KEY_ISSUER
		return this.#issuers.get(issuer)?.get(kid);
		// @end
	}

	/** Every key of every issuer (used only by mutants that model a global kid lookup). */
	all(): IssuerKey[] {
		return [...this.#issuers.values()].flatMap((set) => [...set.values()]);
	}
}

export async function importIssuerKey(issuer: string, jwk: PublicJwk): Promise<IssuerKey> {
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new Error("only Ed25519 (OKP) keys are accepted");
	if (jwk.d !== undefined) throw new Error("refusing a private key: a verifier holds public keys only");
	if (typeof jwk.kid !== "string" || jwk.kid.length === 0) throw new Error("a key needs a kid");
	if (jwk.alg !== undefined && jwk.alg !== "EdDSA" && jwk.alg !== "Ed25519") throw new Error(`unexpected alg ${jwk.alg}`);
	if (jwk.use !== undefined && jwk.use !== "sig") throw new Error(`unexpected use ${jwk.use}`);
	const raw = base64UrlDecode(jwk.x ?? "");
	if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
	const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
	return { issuer, kid: jwk.kid, key, raw };
}

export type VerifyFailure =
	| "malformed"
	| "too_large"
	| "alg"
	| "typ"
	| "crit"
	| "kid"
	| "signature"
	| "claims"
	| "aud"
	| "expired"
	| "iat_future"
	| "lifetime"
	| "revoked";

export type VerifyResult = { readonly ok: true; readonly grant: GrantClaims } | { readonly ok: false; readonly reason: VerifyFailure };

export type VerifyOptions = {
	readonly keys: IssuerKeyStore;
	/** This verifier's audience; grants for any other audience are refused. */
	readonly audience: string;
	/** Seconds since the epoch. Defaults to the wall clock. */
	readonly now?: () => number;
	/** The `jti` denylist. */
	readonly isRevoked?: (jti: string) => boolean | Promise<boolean>;
};

const wallClock = () => Math.floor(Date.now() / 1000);

function parseJsonObject(part: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(part)));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

const isClaimString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_CLAIM_CHARS;

/** 1 to 32 rights, each a lowercase word of at most 64 characters. */
const isRightList = (value: unknown): value is readonly string[] =>
	Array.isArray(value) && value.length > 0 && value.length <= MAX_RIGHTS && value.every((right) => typeof right === "string" && RIGHT.test(right));

/** Copies the named claims only; anything else in the payload is dropped. */
function readClaims(payload: Record<string, unknown>): GrantClaims | undefined {
	const { iss, aud, sub, ten, hid, role, rights, name, exp, iat, jti } = payload;
	if (![iss, aud, sub, ten, hid, jti].every(isClaimString)) return undefined;
	if ((role === undefined) === (rights === undefined)) return undefined;
	if (role !== undefined && !ROLES.includes(role as Role)) return undefined;
	if (rights !== undefined && !isRightList(rights)) return undefined;
	if (name !== undefined && (typeof name !== "string" || name.length > MAX_CLAIM_CHARS)) return undefined;
	if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(iat)) return undefined;
	return {
		iss: iss as string,
		aud: aud as string,
		sub: sub as string,
		ten: ten as string,
		hid: hid as string,
		...(role === undefined ? { rights: [...(rights as readonly string[])] } : { role: role as Role }),
		...(name === undefined ? {} : { name: name as string }),
		exp: exp as number,
		iat: iat as number,
		jti: jti as string,
	};
}

type Decoded = {
	readonly signingInput: Uint8Array<ArrayBuffer>;
	readonly header: Record<string, unknown>;
	readonly payload: Record<string, unknown>;
	readonly signature: Uint8Array<ArrayBuffer>;
};

/** Splits a compact JWS into its parsed header and payload and its signature bytes, or names why it cannot. */
function decode(token: unknown): Decoded | VerifyFailure {
	if (typeof token !== "string") return "malformed";
	if (token.length > MAX_TOKEN_CHARS) return "too_large";
	const parts = token.split(".");
	if (parts.length !== 3) return "malformed";
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
	const header = parseJsonObject(headerPart);
	const payload = parseJsonObject(payloadPart);
	if (header === undefined || payload === undefined) return "malformed";
	try {
		const signature = base64UrlDecode(signaturePart);
		return { signingInput: new TextEncoder().encode(`${headerPart}.${payloadPart}`), header, payload, signature };
	} catch {
		return "malformed";
	}
}

/** The rules a signed grant's claims must meet: audience, expiry, issue time, lifetime and revocation. */
async function checkClaims(grant: GrantClaims, options: VerifyOptions): Promise<VerifyFailure | undefined> {
	// @check V_AUD
	if (grant.aud !== options.audience) return "aud";
	// @end
	const now = (options.now ?? wallClock)();
	// @check V_EXP
	if (grant.exp <= now - LEEWAY_SECONDS) return "expired";
	// @end
	if (grant.iat > now + LEEWAY_SECONDS) return "iat_future";
	// @check V_LIFETIME
	if (grant.exp - grant.iat > MAX_LIFETIME_SECONDS) return "lifetime";
	// @end
	// @check V_REVOKED
	if (options.isRevoked !== undefined && (await options.isRevoked(grant.jti))) return "revoked";
	// @end
	return undefined;
}

/** Verifies a compact JWS grant. Never throws for bad input; returns the first failed rule. */
export async function verifyGrant(token: string, options: VerifyOptions): Promise<VerifyResult> {
	const fail = (reason: VerifyFailure): VerifyResult => ({ ok: false, reason });
	const decoded = decode(token);
	if (typeof decoded === "string") return fail(decoded);
	const { signingInput, header, payload, signature } = decoded;

	// The algorithm is fixed by the verifier, never chosen by the token: refuses none, HS256 and everything else.
	// @check V_ALG
	if (header.alg !== "EdDSA" && header.alg !== "Ed25519") return fail("alg");
	// @end
	// @check V_TYP
	if (header.typ !== GRANT_TYP) return fail("typ");
	// @end
	if (header.crit !== undefined) return fail("crit");
	if (typeof header.kid !== "string" || typeof payload.iss !== "string") return fail("kid");

	// The key set is chosen by the (still unverified) iss; after a valid signature, iss is proven too, because the
	// key belongs to that issuer only.
	const entry = options.keys.get(payload.iss, header.kid);
	// @check V_KID
	if (entry === undefined) return fail("kid");
	// @end
	// @check V_SIG
	const valid = await crypto.subtle.verify({ name: "Ed25519" }, entry.key, signature, signingInput);
	// @end
	if (!valid) return fail("signature");

	const grant = readClaims(payload);
	if (grant === undefined) return fail("claims");
	const failed = await checkClaims(grant, options);
	return failed === undefined ? { ok: true, grant } : fail(failed);
}

export function principalOf(grant: GrantClaims): GrantPrincipal {
	return {
		kind: "grant",
		iss: grant.iss,
		sub: grant.sub,
		ten: grant.ten,
		hid: grant.hid,
		...(grant.role === undefined ? {} : { role: grant.role }),
		rights: [...(grant.role === undefined ? (grant.rights ?? []) : ROLE_RIGHTS[grant.role])],
		...(grant.name === undefined ? {} : { name: grant.name }),
		jti: grant.jti,
		exp: grant.exp,
	};
}

/** A principal object as `principalOf` makes it. A role's principal holds no right outside that role. */
export function isGrantPrincipal(value: unknown): value is GrantPrincipal {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		p.kind === "grant" &&
		[p.iss, p.sub, p.ten, p.hid, p.jti].every(isClaimString) &&
		(p.role === undefined || ROLES.includes(p.role as Role)) &&
		isRightList(p.rights) &&
		(p.role === undefined || p.rights.every((right) => ROLE_RIGHTS[p.role as Role].includes(right))) &&
		(p.name === undefined || (typeof p.name === "string" && p.name.length <= MAX_CLAIM_CHARS)) &&
		Number.isSafeInteger(p.exp)
	);
}

export type Decision = { readonly ok: true; readonly principal: GrantPrincipal } | { readonly ok: false; readonly reason: string };

/**
 * May `principal` use `right` on the session `hid`? The session's tenant and issuer come from the verifier's own
 * directory, and the grant must agree with both. Pure and synchronous apart from the directory lookup. Reasons:
 * `not_a_grant`, `other_session`, `unknown_session`, `other_tenant`, `other_issuer`, `expired` and `right`.
 */
export function authorize(principal: unknown, hid: string, right: string, directory: HarnessDirectory, now: number = wallClock()): Decision {
	const deny = (reason: string): Decision => ({ ok: false, reason });
	if (!isGrantPrincipal(principal)) return deny("not_a_grant");
	// @check A_SESSION
	if (principal.hid !== hid) return deny("other_session");
	// @end
	const record = directory.get(hid);
	if (record === undefined) return deny("unknown_session");
	// @check A_TENANT
	if (record.tenant !== principal.ten) return deny("other_tenant");
	// @end
	// @check A_ISSUER
	if (record.issuer !== principal.iss) return deny("other_issuer");
	// @end
	// @check A_EXP
	if (principal.exp <= now) return deny("expired");
	// @end
	// @check A_ROLE
	if (!principal.rights.includes(right)) return deny("right");
	// @end
	return { ok: true, principal };
}

/** The author of a message: always the verified principal, never an argument. */
export type Author = { readonly iss: string; readonly sub: string; readonly name?: string };

export function authorOf(principal: GrantPrincipal): Author {
	return principal.name === undefined ? { iss: principal.iss, sub: principal.sub } : { iss: principal.iss, sub: principal.sub, name: principal.name };
}

/** An issuer's signing key: the private key signs, `publicJwk` goes to every verifier's `IssuerKeyStore`. */
export type SigningKey = { readonly kid: string; readonly privateKey: CryptoKey; readonly publicJwk: PublicJwk };

/** A new Ed25519 signing key. The private key cannot be exported. */
export async function generateSigningKey(kid: string): Promise<SigningKey> {
	if (!isClaimString(kid)) throw new TypeError("generateSigningKey: a kid is 1 to 256 characters");
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { kid, privateKey: pair.privateKey, publicJwk: Object.freeze({ kty: "OKP", crv: "Ed25519", x: base64UrlEncode(raw), kid, alg: "EdDSA", use: "sig" }) };
}

/** The claims a minter chooses; `mintGrant` sets `iat`, `exp` and `jti`. */
export type MintClaims = Omit<GrantClaims, "iat" | "exp" | "jti">;

export type MintOptions = {
	readonly claims: MintClaims;
	readonly key: Pick<SigningKey, "kid" | "privateKey">;
	/** Whole seconds from 1 to `MAX_LIFETIME_SECONDS`. */
	readonly lifetimeSeconds: number;
	/** Seconds since the epoch. Defaults to the wall clock. */
	readonly now?: () => number;
};

/**
 * Signs a grant: `iat` is now, `exp` is `iat + lifetimeSeconds`, `jti` is random. Throws for a lifetime outside 1 to
 * 900 seconds, for claims `verifyGrant` would refuse, and for a token over 4096 characters.
 */
export async function mintGrant(options: MintOptions): Promise<string> {
	const { claims: c, key, lifetimeSeconds } = options;
	if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_LIFETIME_SECONDS) {
		throw new RangeError(`mintGrant: lifetimeSeconds must be a whole number from 1 to ${MAX_LIFETIME_SECONDS}`);
	}
	if (!isClaimString(key.kid)) throw new TypeError("mintGrant: a key needs a kid");
	const iat = (options.now ?? wallClock)();
	// Named fields only: nothing else the caller's object holds is signed.
	const grant = readClaims({ iss: c.iss, aud: c.aud, sub: c.sub, ten: c.ten, hid: c.hid, role: c.role, rights: c.rights, name: c.name, iat, exp: iat + lifetimeSeconds, jti: crypto.randomUUID() });
	if (grant === undefined) throw new TypeError("mintGrant: invalid claims");
	const signingInput = `${encodeJson({ alg: "EdDSA", typ: GRANT_TYP, kid: key.kid })}.${encodeJson(grant)}`;
	const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(signingInput));
	const token = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
	if (token.length > MAX_TOKEN_CHARS) throw new RangeError(`mintGrant: the grant is over ${MAX_TOKEN_CHARS} characters`);
	return token;
}
