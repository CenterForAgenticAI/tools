/**
 * Cross-process lineage substrate for delegate.
 *
 * AsyncLocalStorage (see `src/depth-guard.ts`) tracks recursion depth + the
 * agent chain WITHIN a single process. It does NOT cross a process boundary:
 * a detached child process (the `orchestrate` shape, spec 0005) or a `pi -c`
 * session spawned by a parent delegate inherits NONE of the parent's async
 * context, so it reads `currentDepth() === 0` regardless of how deep it
 * actually sits in the delegation tree. The depth guard then silently
 * under-counts across the boundary and lineage diagnostics go blind.
 *
 * This module makes the depth frame SERIALIZABLE: the parent writes the
 * frame into a set of namespaced environment variables when constructing a
 * child, and the child reconstructs the frame from `process.env` on start.
 * The env-serialized form is the AUTHORITATIVE boundary-crossing source of
 * truth; AsyncLocalStorage remains the fast in-process carrier of the SAME
 * unified frame (one type — see `DepthFrame`).
 *
 * ## Pattern provenance
 *
 * The env-propagation pattern is adopted from pi-subagents-nicobailon
 * (github.com/nicobailon/pi-subagents, MIT), specifically
 * `runs/shared/pi-args.ts`, which propagates lineage through the child's
 * environment via `PI_SUBAGENT_PARENT_*` vars (depth / run-id / path /
 * root-run-id / child-index) gated by a parent capability token. We adopt
 * the SHAPE of that pattern but deliberately do NOT reuse the variable
 * names — pi-delegate namespaces its own vars under `PI_DELEGATE_LINEAGE_*`
 * so that both extensions can be loaded in the same process without
 * colliding on the `PI_SUBAGENT_*` namespace. Name mapping:
 *
 *   nicobailon `PI_SUBAGENT_PARENT_DEPTH`     → `PI_DELEGATE_LINEAGE_DEPTH`
 *   nicobailon `PI_SUBAGENT_PARENT_PATH`      → `PI_DELEGATE_LINEAGE_CHAIN`
 *   nicobailon `PI_SUBAGENT_PARENT_RUN_ID`    → `PI_DELEGATE_LINEAGE_RUN_ID`
 *   nicobailon `PI_SUBAGENT_PARENT_ROOT_RUN`  → `PI_DELEGATE_LINEAGE_ROOT_RUN_ID`
 *   nicobailon `PI_SUBAGENT_PARENT_CHILD_IDX` → `PI_DELEGATE_LINEAGE_CHILD_INDEX`
 *   nicobailon capability token               → `PI_DELEGATE_LINEAGE_CAP_TOKEN`
 *   (no nicobailon equivalent)                → `PI_DELEGATE_LINEAGE_EFFECTIVE_MAX`
 *
 * ## Cap-token integrity model (REQ-LIN-4)
 *
 * The threat is a child PROCESS that wants to UNDER-report its depth (or
 * inflate `effectiveMax`) to escape the recursion cap. The child receives the
 * lineage env, so it can rewrite any field freely. A naive "is the token
 * present and non-empty?" check is trivially forgeable — the child just sets
 * `CAP_TOKEN=anything` alongside `DEPTH=0` and walks away with full headroom.
 *
 * The fix is an HMAC that BINDS the token to the exact payload it authorizes:
 *
 *   - The ROOT process (depth 0, no inherited lineage) lazily generates a
 *     random `rootSecret` (32 bytes, `crypto.randomBytes`) ONCE and holds it
 *     in module memory. The secret is NEVER serialized into any child env —
 *     only the MAC output (`CAP_TOKEN`) travels.
 *   - `serializeLineage(frame)` sets
 *     `CAP_TOKEN = base64url(HMAC-SHA256(rootSecret, canonical(frame)))`,
 *     where `canonical(frame)` is a stable string over
 *     `depth | effectiveMax | childIndex | runId | rootRunId | chain`.
 *   - `deserializeLineage(env)` recomputes the HMAC over the PRESENTED
 *     payload with the in-memory `rootSecret` and compares (constant-time) to
 *     the presented `CAP_TOKEN`. `tampered = (token absent) || (MAC !== token)`.
 *     A child that rewrites `DEPTH=0` but keeps the parent's token FAILS
 *     (the token was minted for the real, deeper payload); a child that
 *     fabricates a token CANNOT match without the secret. Either way the
 *     existing fail-closed clamp (below) denies it any headroom.
 *
 * ### Cross-process asymmetric-signature inheritance (spec 0005 / REQ-ORCH-5)
 *
 * When the VERIFIER is a DIFFERENT process than the MINTER (a detached
 * `orchestrate` child), it has its own freshly-minted `rootSecret` and does
 * NOT share the parent's. The in-process MAC path (above) therefore fails
 * verification → fail-closed → clamps to the floor. That is the SAFE default
 * and remains UNCHANGED for the generic cross-boundary case (a bare `pi -c`
 * session, an unexpected spawn): such a process inherits NO signature material
 * and stays clamped.
 *
 * For the DELIBERATE detached-`orchestrate` spawn, spec 0005 lets the child
 * run under its TRUE inherited cap via an ASYMMETRIC signature.
 *
 * #### Why NOT a symmetric derived key (the forgeable scheme this REPLACES)
 *
 * An earlier design shipped a per-child SYMMETRIC HMAC key to the child and
 * verified `HMAC(shippedKey, payload)`. That is UNSOUND: HMAC is symmetric, so
 * the verifier and the signer use the SAME key. A child that HOLDS the key can
 * recompute a valid MAC for ANY payload it likes — rewrite `effectiveMax=99`,
 * re-MAC with the shipped key, and the verification passes. A cross-model
 * reviewer confirmed this with a live exploit (mutate the env, re-HMAC, the
 * child authenticates a forged frame and inherits inflated headroom). You
 * CANNOT hand the verifier the signing key. That path is fully removed — there
 * is no symmetric fallback to forge through.
 *
 * #### The asymmetric fix (Ed25519, `node:crypto`)
 *
 *   - The parent (`serializeLineageDetached`) mints a FRESH ephemeral Ed25519
 *     keypair for THIS child dispatch (`crypto.generateKeyPairSync('ed25519')`)
 *     and SIGNS the canonical frame payload — which INCLUDES the child's
 *     `lineagePath`, so the signature is PATH-BOUND — with the PRIVATE key
 *     (`crypto.sign(null, canonical, privateKey)`; Ed25519 uses the `null`
 *     algorithm). It ships the signature as `CAP_TOKEN` (base64url) and the
 *     PUBLIC key as `PI_DELEGATE_LINEAGE_PUBKEY` (SPKI DER, base64url). The
 *     PRIVATE key is NEVER serialized — it is discarded the instant the
 *     signature is produced; the parent does not even retain it.
 *   - The child (`deserializeLineageDetached`) re-imports the public key,
 *     recomputes the canonical payload from the PRESENTED env fields, and
 *     verifies the signature (`crypto.verify(null, canonical, pubKey, sig)`).
 *     An AUTHENTIC frame verifies → the child seeds its REAL inherited depth +
 *     headroom (cap ≥ 3 for foreground→orchestrate→worker→reviewer). An ABSENT
 *     or INVALID pubkey / signature falls back to the in-process MAC path,
 *     which (cross-process) clamps.
 *
 * #### Why this is forgery-proof where the symmetric scheme was not
 *
 * The child holds ONLY the PUBLIC key. A public key can VERIFY a signature but
 * CANNOT mint one — that requires the private key, which never left the parent
 * and no longer exists. So the child CANNOT produce a valid signature for a
 * mutated payload (inflated `effectiveMax`, shallower `depth`, a different
 * `lineagePath`): any mutation breaks the signature, verification fails, and
 * the frame clamps to the floor. The reviewer's exploit — rewrite the env and
 * re-sign — is structurally impossible without the discarded private key.
 *
 * ### Cross-process security boundary (the honest model)
 *
 * `rootSecret` NEVER leaves the parent, and the Ed25519 PRIVATE key never
 * leaves the parent either (it is ephemeral and discarded post-sign). The
 * signature is bound to the child's `lineagePath`, so a process on a DIFFERENT
 * path that replays this signature against a different-path payload fails
 * verification. The protected property is full payload integrity + path
 * binding: the child cannot inflate its OWN headroom (no private key to
 * re-sign), and a different tree cannot impersonate THIS child's frame.
 *
 * Unlike the symmetric scheme this replaces, there is NO "trusted not to lie
 * to itself" caveat: the child genuinely cannot mint a signature for a frame
 * it was not handed. The in-process `rootSecret`-keyed model (above) is
 * UNWEAKENED and UNTOUCHED: the pubkey/signature env is consulted ONLY on the
 * detached path, and a generic boundary crossing with no pubkey still fails
 * closed exactly as before.
 *
 * ## Payload sensitivity
 *
 * The serialized payload carries NO secrets — `rootSecret` never leaves
 * process memory and the ephemeral Ed25519 PRIVATE key is discarded after
 * signing. The in-process `CAP_TOKEN` is an HMAC (a one-way digest); the
 * detached `CAP_TOKEN` is an Ed25519 signature and `PUBKEY` is a public key
 * (safe to publish by construction); run-ids, depth, and the agent chain are
 * low-risk diagnostics.
 */

import {
	createHmac,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign as cryptoSign,
	timingSafeEqual,
	verify as cryptoVerify,
} from "node:crypto";
import type { DepthFrame } from "./depth-guard.js";

/** Namespaced env-var keys for the serialized lineage frame. */
export const LINEAGE_ENV = {
	DEPTH: "PI_DELEGATE_LINEAGE_DEPTH",
	CHAIN: "PI_DELEGATE_LINEAGE_CHAIN",
	EFFECTIVE_MAX: "PI_DELEGATE_LINEAGE_EFFECTIVE_MAX",
	RUN_ID: "PI_DELEGATE_LINEAGE_RUN_ID",
	ROOT_RUN_ID: "PI_DELEGATE_LINEAGE_ROOT_RUN_ID",
	CHILD_INDEX: "PI_DELEGATE_LINEAGE_CHILD_INDEX",
	CAP_TOKEN: "PI_DELEGATE_LINEAGE_CAP_TOKEN",
} as const;

/**
 * Cross-process verification PUBLIC KEY env var (spec 0005 / REQ-ORCH-5).
 *
 * DELIBERATELY a STANDALONE const, NOT a member of `LINEAGE_ENV`: it is
 * emitted ONLY on the detached-child env path (`serializeLineageDetached`) and
 * NEVER by the in-process `serializeLineage` round-trip. Keeping it out of
 * `LINEAGE_ENV` preserves the seven-key in-process contract that the rest of
 * the module (and `lineage.test.ts`) iterates over, so the additive detached
 * path does not widen what an in-process serialize emits.
 *
 * The parent ships the Ed25519 PUBLIC key (SPKI DER, base64url) of a fresh
 * ephemeral per-dispatch keypair, while the detached `CAP_TOKEN` carries the
 * SIGNATURE over the child's canonical frame payload. The child — which does
 * NOT share the parent's in-memory `rootSecret` — imports this public key,
 * VERIFIES the signature, and seeds REAL inherited headroom on success. A
 * public key can verify but cannot SIGN, so the child cannot forge a frame;
 * the PRIVATE key is discarded after signing and never serialized.
 */
export const LINEAGE_PUBKEY_ENV = "PI_DELEGATE_LINEAGE_PUBKEY";

/**
 * Module-level root secret used as the HMAC key for cap-token integrity.
 *
 * Generated lazily on first use (the first `serializeLineage` at the tree
 * root) and held ONLY in process memory — it is never written to any env var
 * and never crosses a process boundary. Within a process, both the minter
 * (`serializeLineage`) and the verifier (`deserializeLineage`) share this
 * exact secret, so an authentic in-process round-trip verifies. A separate
 * process gets its own secret, so inherited frames from a different process
 * fail verification and fall back to the fail-closed clamp (see module doc).
 */
let rootSecret: Buffer | undefined;

function getRootSecret(): Buffer {
	if (rootSecret === undefined) rootSecret = randomBytes(32);
	return rootSecret;
}

/**
 * Canonicalize the agent chain to a single lossless string. The chain is
 * JSON-encoded so an agent name containing ANY character (including the
 * historical U+001F unit-separator delimiter) round-trips without splitting
 * or merging entries. This exact string is used identically as the `CHAIN`
 * env value, in the MAC payload, and on the deserialize side, so the three
 * sites never disagree.
 */
function canonicalChain(chain: string[]): string {
	return JSON.stringify(chain);
}

/** Parse a JSON-encoded chain back to a string array, or `undefined` on garbage. */
function parseChain(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
			return undefined;
		}
		return parsed as string[];
	} catch {
		return undefined;
	}
}

/**
 * Compute the cap-token MAC over a canonical rendering of the lineage
 * payload. The field order and the `|` separator are part of the contract —
 * `serializeLineage` and `deserializeLineage` MUST render the payload
 * identically or the MAC will never verify. The `chainCanonical` argument is
 * the already-canonicalized chain string (see `canonicalChain`) so the
 * serialize and deserialize sides feed byte-identical input.
 */
function computeCapToken(args: {
	depth: number;
	effectiveMax: number;
	childIndex: number;
	runId: string;
	rootRunId: string;
	chainCanonical: string;
}): string {
	const payload = [
		String(args.depth),
		String(args.effectiveMax),
		String(args.childIndex),
		args.runId,
		args.rootRunId,
		args.chainCanonical,
	].join("|");
	return createHmac("sha256", getRootSecret())
		.update(payload)
		.digest("base64url");
}

/** Constant-time string compare that tolerates length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/**
 * Mint a fresh per-tree diagnostic nonce for a root (outermost) frame.
 *
 * NOTE: this nonce is the in-memory `DepthFrame.capToken` field only — it is
 * a diagnostic tree-identifier carried via AsyncLocalStorage and is NOT the
 * integrity mechanism. Cap-token integrity at the env boundary is the HMAC
 * computed by `serializeLineage` / verified by `deserializeLineage` (see the
 * module doc). The env `CAP_TOKEN` is always the MAC, never this nonce.
 */
export function mintCapToken(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Serialize a `DepthFrame` into namespaced environment variables suitable
 * for injection into a child process's `env`. The returned record is meant
 * to be spread over the child env (`{ ...process.env, ...serializeLineage(frame) }`).
 *
 * Every field is emitted so the child can fully reconstruct the frame. The
 * emitted `CAP_TOKEN` is an HMAC over the canonical payload (keyed by the
 * non-inherited module `rootSecret`), NOT `frame.capToken` — it is what lets
 * the verifier distinguish an authentic inherited frame from a forged/
 * tampered one (REQ-LIN-4).
 */
export function serializeLineage(frame: DepthFrame): Record<string, string> {
	const chainCanonical = canonicalChain(frame.chain);
	const capToken = computeCapToken({
		depth: frame.depth,
		effectiveMax: frame.effectiveMax,
		childIndex: frame.childIndex,
		runId: frame.runId,
		rootRunId: frame.rootRunId,
		chainCanonical,
	});
	return {
		[LINEAGE_ENV.DEPTH]: String(frame.depth),
		[LINEAGE_ENV.CHAIN]: chainCanonical,
		[LINEAGE_ENV.EFFECTIVE_MAX]: String(frame.effectiveMax),
		[LINEAGE_ENV.RUN_ID]: frame.runId,
		[LINEAGE_ENV.ROOT_RUN_ID]: frame.rootRunId,
		[LINEAGE_ENV.CHILD_INDEX]: String(frame.childIndex),
		[LINEAGE_ENV.CAP_TOKEN]: capToken,
	};
}

/** Parse a non-negative integer, returning `undefined` for anything else. */
function parseNonNegInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (!/^\d+$/.test(raw.trim())) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Reconstruct a `DepthFrame` from inherited environment variables.
 *
 * Returns `undefined` when NO lineage vars are present (a genuine top-level
 * process with no inherited frame) — callers then seed a fresh root frame.
 *
 * ## Fail-closed contract (REQ-LIN-4)
 *
 * The threat model is a child that tampers with the env to claim a SHALLOWER
 * depth than it truly sits at, escaping the recursion cap. Defense — the cap
 * token is an HMAC bound to the presented payload (see the module doc):
 *
 *   - We recompute `HMAC(rootSecret, canonical(presented payload))` and
 *     compare it (constant-time) to the presented `CAP_TOKEN`. The frame is
 *     TAMPERED when the token is absent/empty OR the recomputed MAC does not
 *     match. A child that rewrites `DEPTH` invalidates the inherited token; a
 *     child that fabricates a token cannot match without `rootSecret`.
 *   - A tampered frame does NOT get to use the env's depth as a license to
 *     recurse: the returned frame reports the deepest plausible depth by
 *     pinning `depth` to AT-LEAST its claimed value (and to
 *     `Number.MAX_SAFE_INTEGER` when the claim is itself unreadable) and
 *     clamping `effectiveMax` down to `depth`, so the very next
 *     `runWithDepth` is at-or-over the cap and throws. A tampered frame can
 *     never yield headroom.
 *
 * In short: a partial, forged, or cross-process-unverifiable lineage env can
 * only ever make the guard STRICTER, never looser. There is no
 * shallower-than-actual escape.
 */
export function deserializeLineage(
	env: Record<string, string | undefined> = process.env,
): DepthFrame | undefined {
	const rawDepth = env[LINEAGE_ENV.DEPTH];
	const rawChain = env[LINEAGE_ENV.CHAIN];
	const rawMax = env[LINEAGE_ENV.EFFECTIVE_MAX];
	const runId = env[LINEAGE_ENV.RUN_ID];
	const rootRunId = env[LINEAGE_ENV.ROOT_RUN_ID];
	const rawChildIndex = env[LINEAGE_ENV.CHILD_INDEX];
	const capToken = env[LINEAGE_ENV.CAP_TOKEN];

	// No lineage env at all → genuine top-level process, no inherited frame.
	const anyPresent =
		rawDepth !== undefined ||
		rawChain !== undefined ||
		rawMax !== undefined ||
		runId !== undefined ||
		rootRunId !== undefined ||
		rawChildIndex !== undefined ||
		capToken !== undefined;
	if (!anyPresent) return undefined;

	const parsedDepth = parseNonNegInt(rawDepth);
	const parsedMax = parseNonNegInt(rawMax);
	const parsedChildIndex = parseNonNegInt(rawChildIndex);
	const parsedChain = parseChain(rawChain);

	// Recompute the MAC over the PRESENTED payload and compare to the
	// presented token. The chain canonicalization here MUST match
	// serializeLineage exactly: we re-encode the parsed chain (falling back to
	// the raw string when the chain is unparseable so a tampered/garbage chain
	// still feeds the MAC deterministically and simply fails to match).
	const chainForMac =
		parsedChain !== undefined ? canonicalChain(parsedChain) : (rawChain ?? "");
	const tokenPresent = capToken !== undefined && capToken.trim() !== "";
	let macValid = false;
	if (tokenPresent && parsedDepth !== undefined && parsedMax !== undefined) {
		const expected = computeCapToken({
			depth: parsedDepth,
			effectiveMax: parsedMax,
			childIndex: parsedChildIndex ?? 0,
			runId: runId ?? "",
			rootRunId: rootRunId ?? runId ?? "",
			chainCanonical: chainForMac,
		});
		macValid = constantTimeEqual(expected, capToken);
	}
	const tampered = !macValid;

	// Depth: a present-but-tampered env, or a present env with a garbage
	// depth, is assumed to be AT LEAST as deep as it claims (default to the
	// deepest plausible depth when the claim is unreadable) — never shallower.
	const depth = parsedDepth ?? (tampered ? Number.MAX_SAFE_INTEGER : 0);

	const chain = parsedChain ?? [];

	// effectiveMax: when tampered, clamp the cap down to the current depth so
	// the NEXT runWithDepth (attemptedDepth = depth + 1 > effectiveMax)
	// throws — the tampered frame gets zero headroom. When authentic, honor
	// the inherited cap (falling back to depth if unreadable).
	const effectiveMax = tampered ? depth : (parsedMax ?? depth);

	return {
		depth,
		chain,
		effectiveMax,
		runId: runId ?? "",
		rootRunId: rootRunId ?? runId ?? "",
		childIndex: parsedChildIndex ?? 0,
		// Carry the presented token verbatim (the verified MAC for an
		// authentic frame, or whatever the tamperer presented). The
		// fail-closed depth/cap above already neutralizes any escape.
		capToken: capToken ?? "",
		// Issue #9 — surface non-verification to consumers. The clamping above
		// is the (unchanged) fail-closed AUTHORITY response; this flag exists
		// so `runWithDepth` can additionally log a diagnostics warning — a
		// forged/tampered frame previously clamped in complete silence, making
		// bypass probes invisible to operators. NOTE: across a process
		// boundary a frame ALSO reads tampered=true simply because the MAC was
		// keyed by the spawner's rootSecret; the warning text accounts for that.
		...(tampered ? { tampered: true as const } : {}),
	};
}

/**
 * The addressable lineage path for a frame:
 * `<rootRunId>/<runId>#<childIndex>`. This is THE id/path scheme the event
 * bus (spec 0004) consumes for routing — exported here as the single shared
 * helper so the two systems agree on one scheme. `rootRunId` anchors the
 * whole delegation tree; `runId` identifies this node; `childIndex` orders
 * siblings under a common parent.
 */
export function lineagePath(frame: DepthFrame): string {
	return `${frame.rootRunId}/${frame.runId}#${frame.childIndex}`;
}

/**
 * The full root→self ANCESTOR path for a frame: a `/`-joined chain of
 * `runId#childIndex` segments, one per level of the delegation tree
 * (spec 0004 / REQ-BUS-2). This is the address the event bus uses for TRUE
 * ancestry discrimination: ancestor A is an ancestor of event E iff
 * `E.ancestorPath` is `A.ancestorPath` followed by `/` (a strict prefix) —
 * a depth comparison alone wrongly treats an unrelated same-root COUSIN at
 * greater depth as a descendant, which would let a busy cousin mask a
 * genuinely-stuck immediate run and block its legitimate wind-down forever.
 *
 * The id-path is accumulated in `runWithDepth` (`src/depth-guard.ts`) as the
 * in-process `DepthFrame.idPath`. When it is absent — a frame reconstructed
 * across a process boundary via `deserializeLineage`, which does NOT carry
 * the per-level id chain — this falls back to the LEAF-only `lineagePath`.
 * That fallback is suppress-only safe: a cross-process detached child emits
 * its OWN subtree and is liveness-checked by pid, so a missing id-path can
 * only narrow (never widen) what counts as a descendant.
 */
export function lineageAncestorPath(frame: DepthFrame): string {
	if (frame.idPath && frame.idPath.length > 0) return frame.idPath.join("/");
	return lineagePath(frame);
}

/**
 * Verify that `presentedToken` is the authentic cap-token MAC for `frame`
 * (spec 0004 control-inbox auth, REQ-BUS-3). This is the standalone
 * counterpart to the inline check in `deserializeLineage`: it recomputes
 * `HMAC(rootSecret, canonical(frame))` and constant-time compares it to the
 * presented token.
 *
 * The security property the control inbox leans on: the MAC is keyed by the
 * non-inherited, in-memory `rootSecret`, so ONLY a process in the same
 * delegation tree (which shares the minter's secret) can produce a token
 * that validates for a given frame. An UNRELATED process cannot forge a
 * valid token — its `verifyCapToken` would be computed under a different
 * secret — so it cannot address a steer/cancel at someone else's child.
 * Reuses the exact `computeCapToken` payload rendering and `constantTimeEqual`
 * comparison used by the serialize/deserialize round-trip, so an authentic
 * token minted by `serializeLineage(frame)` verifies here byte-for-byte.
 *
 * Returns `false` (never throws) for an absent / empty token so callers can
 * treat verification failure and a missing token identically — REJECT.
 */
export function verifyCapToken(
	frame: DepthFrame,
	presentedToken: string | undefined,
): boolean {
	if (presentedToken === undefined || presentedToken.trim() === "")
		return false;
	const expected = computeCapToken({
		depth: frame.depth,
		effectiveMax: frame.effectiveMax,
		childIndex: frame.childIndex,
		runId: frame.runId,
		rootRunId: frame.rootRunId,
		chainCanonical: canonicalChain(frame.chain),
	});
	return constantTimeEqual(expected, presentedToken);
}

// ── Cross-process asymmetric-signature path (spec 0005 / REQ-ORCH-5) ─────────
//
// The functions below are the ADDITIVE detached-`orchestrate` path. They do
// NOT touch the in-process `serializeLineage` / `deserializeLineage` round-trip
// (the spec-0003 cap model) — a generic boundary crossing with no signature
// material still flows through `deserializeLineage` and fails closed. See the
// module doc's "Cross-process asymmetric-signature inheritance" section.
//
// This REPLACES an earlier symmetric derived-key scheme that was forgeable: a
// child handed an HMAC key could re-MAC any payload it liked. An Ed25519
// signature gives the child a VERIFY-ONLY public key — it can confirm the
// parent's frame but cannot mint a signature for a mutated one.

/**
 * Render the canonical payload SIGNED on the detached path. Identical field
 * order + `|` separator to `computeCapToken`'s in-process payload, EXCEPT it
 * additionally binds the child's `lineagePath` as a trailing segment so the
 * signature is PATH-BOUND: a signature minted for path A cannot validate a
 * payload that claims path B (the recomputed canonical string differs). The
 * serialize and verify sides MUST render this identically or verification
 * never succeeds.
 */
function canonicalDetachedPayload(args: {
	depth: number;
	effectiveMax: number;
	childIndex: number;
	runId: string;
	rootRunId: string;
	chainCanonical: string;
	lineagePathStr: string;
}): Buffer {
	const payload = [
		String(args.depth),
		String(args.effectiveMax),
		String(args.childIndex),
		args.runId,
		args.rootRunId,
		args.chainCanonical,
		args.lineagePathStr,
	].join("|");
	return Buffer.from(payload, "utf8");
}

/**
 * Serialize a `DepthFrame` for a DETACHED child process (spec 0005). Identical
 * to `serializeLineage` EXCEPT the `CAP_TOKEN` is an Ed25519 SIGNATURE over the
 * canonical (path-bound) frame payload, and the matching PUBLIC key is emitted
 * in `LINEAGE_PUBKEY_ENV` so the child — which lacks the parent's secrets — can
 * VERIFY (but never re-sign) its own inherited frame.
 *
 * A FRESH ephemeral Ed25519 keypair is minted per dispatch; the PRIVATE key is
 * used to sign and then discarded (never stored, never serialized). Because the
 * child holds only the public key, it cannot forge a signature for a mutated
 * payload (inflated cap, shallower depth, a different path) — any mutation
 * breaks verification and the frame clamps. `rootSecret` is irrelevant here and
 * never emitted.
 *
 * Spread over the child env: `{ ...process.env, ...serializeLineageDetached(frame) }`.
 */
export function serializeLineageDetached(
	frame: DepthFrame,
): Record<string, string> {
	const chainCanonical = canonicalChain(frame.chain);
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const canonical = canonicalDetachedPayload({
		depth: frame.depth,
		effectiveMax: frame.effectiveMax,
		childIndex: frame.childIndex,
		runId: frame.runId,
		rootRunId: frame.rootRunId,
		chainCanonical,
		lineagePathStr: lineagePath(frame),
	});
	// Ed25519 signs with the `null` algorithm (PureEdDSA hashes internally).
	const signature = cryptoSign(null, canonical, privateKey);
	const pubkeyB64 = publicKey
		.export({ type: "spki", format: "der" })
		.toString("base64url");
	// privateKey goes out of scope here and is GC'd — it is never serialized,
	// never retained. The child receives only the verify-only public key.
	return {
		[LINEAGE_ENV.DEPTH]: String(frame.depth),
		[LINEAGE_ENV.CHAIN]: chainCanonical,
		[LINEAGE_ENV.EFFECTIVE_MAX]: String(frame.effectiveMax),
		[LINEAGE_ENV.RUN_ID]: frame.runId,
		[LINEAGE_ENV.ROOT_RUN_ID]: frame.rootRunId,
		[LINEAGE_ENV.CHILD_INDEX]: String(frame.childIndex),
		[LINEAGE_ENV.CAP_TOKEN]: signature.toString("base64url"),
		[LINEAGE_PUBKEY_ENV]: pubkeyB64,
	};
}

/**
 * Reconstruct a `DepthFrame` from a detached child's inherited env, verifying
 * the inherited frame with the shipped Ed25519 PUBLIC key + signature
 * (spec 0005 / REQ-ORCH-5).
 *
 * Resolution order:
 *   1. NO lineage env at all → `undefined` (genuine top-level; seed a root).
 *   2. A `PUBKEY` + `CAP_TOKEN` (signature) are present → import the public
 *      key, recompute the canonical (path-bound) payload from the PRESENTED
 *      fields, and `crypto.verify` the signature. On a VALID signature the
 *      frame is AUTHENTIC → return it with its REAL inherited depth + headroom
 *      (cap honored). On an INVALID signature (any mutated field, including a
 *      different path) — or an unparseable depth/max, an unimportable key, a
 *      malformed signature — fall through to the clamp.
 *   3. NO `PUBKEY` (a generic boundary crossing) OR a failed signature check →
 *      delegate to `deserializeLineage`, which applies the in-process
 *      `rootSecret` MAC path. Cross-process that fails closed → clamp.
 *
 * In all failure modes the result is no looser than `deserializeLineage` would
 * produce — the signature path can only GRANT an authentic child its true
 * headroom, never widen a tampered one. Crucially, the child holds ONLY the
 * public key: it can verify the parent's signature but cannot mint a new one
 * for a forged payload, so there is no symmetric-key forgery escape.
 */
export function deserializeLineageDetached(
	env: Record<string, string | undefined> = process.env,
): DepthFrame | undefined {
	const rawDepth = env[LINEAGE_ENV.DEPTH];
	const rawChain = env[LINEAGE_ENV.CHAIN];
	const rawMax = env[LINEAGE_ENV.EFFECTIVE_MAX];
	const runId = env[LINEAGE_ENV.RUN_ID];
	const rootRunId = env[LINEAGE_ENV.ROOT_RUN_ID];
	const rawChildIndex = env[LINEAGE_ENV.CHILD_INDEX];
	const capToken = env[LINEAGE_ENV.CAP_TOKEN];
	const rawPubkey = env[LINEAGE_PUBKEY_ENV];

	const anyPresent =
		rawDepth !== undefined ||
		rawChain !== undefined ||
		rawMax !== undefined ||
		runId !== undefined ||
		rootRunId !== undefined ||
		rawChildIndex !== undefined ||
		capToken !== undefined ||
		rawPubkey !== undefined;
	if (!anyPresent) return undefined;

	// No pubkey OR no signature → the in-process path (cross-process: clamp).
	if (
		rawPubkey === undefined ||
		rawPubkey.trim() === "" ||
		capToken === undefined ||
		capToken.trim() === ""
	) {
		return deserializeLineage(env);
	}

	const parsedDepth = parseNonNegInt(rawDepth);
	const parsedMax = parseNonNegInt(rawMax);
	const parsedChildIndex = parseNonNegInt(rawChildIndex);
	const parsedChain = parseChain(rawChain);

	// Need a readable depth + max to verify the signature and honor a cap.
	if (parsedDepth === undefined || parsedMax === undefined) {
		return deserializeLineage(env);
	}

	const chainCanonical =
		parsedChain !== undefined ? canonicalChain(parsedChain) : (rawChain ?? "");

	// The lineage PATH is recomputed from the PRESENTED ids — it is part of the
	// signed payload, so a forged path breaks verification (path-bound).
	const presentedRootRunId = rootRunId ?? runId ?? "";
	const presentedRunId = runId ?? "";
	const presentedChildIndex = parsedChildIndex ?? 0;
	const presentedLineagePath = `${presentedRootRunId}/${presentedRunId}#${presentedChildIndex}`;

	const canonical = canonicalDetachedPayload({
		depth: parsedDepth,
		effectiveMax: parsedMax,
		childIndex: presentedChildIndex,
		runId: presentedRunId,
		rootRunId: presentedRootRunId,
		chainCanonical,
		lineagePathStr: presentedLineagePath,
	});

	// Re-import the public key, decode the signature, and verify. ANY failure
	// (unimportable key, malformed signature, or a signature that does not match
	// the recomputed payload) falls through to the in-process clamp path — the
	// child cannot mint a valid signature for a forged payload (it has no
	// private key), so a mutated frame can never authenticate here.
	const verified = (() => {
		try {
			const pubKey = createPublicKey({
				key: Buffer.from(rawPubkey, "base64url"),
				type: "spki",
				format: "der",
			});
			const signature = Buffer.from(capToken, "base64url");
			// Ed25519 verifies with the `null` algorithm, mirroring the signer.
			return cryptoVerify(null, canonical, pubKey, signature);
		} catch {
			return false;
		}
	})();

	// Signature invalid / unverifiable → fall back to the in-process path
	// (clamps cross-process).
	if (!verified) {
		return deserializeLineage(env);
	}

	// AUTHENTIC under the parent's Ed25519 signature → honor the REAL inherited
	// depth + headroom (no clamp). This is the only place a cross-process child
	// is granted true inherited cap.
	return {
		depth: parsedDepth,
		chain: parsedChain ?? [],
		effectiveMax: parsedMax,
		runId: presentedRunId,
		rootRunId: presentedRootRunId,
		childIndex: presentedChildIndex,
		capToken,
	};
}

/**
 * Test-only: reset the module `rootSecret` so a test can simulate a fresh
 * process (a verifier that does NOT share the minter's secret — the
 * cross-process case). Production code never calls this; the secret persists
 * for the life of the process.
 */
export function __resetRootSecretForTests(): void {
	rootSecret = undefined;
}
