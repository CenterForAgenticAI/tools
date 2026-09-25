import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as publicBarrel from "../../src/verify/index.ts";
import { createVerifier, type VerifierCapabilities } from "../../src/verify/internal.ts";
import { confirmationLine, userChallenge, type SessionReader } from "../../src/verify/user.ts";
import { REPO_ROOT } from "../helpers/source-under-test.ts";
import { systemdContainmentPrerequisite } from "../helpers/verifier-command.ts";

const systemdPrerequisite = await systemdContainmentPrerequisite();

async function source(): Promise<string> {
	return readFile(`${REPO_ROOT}/src/verify/internal.ts`, "utf8");
}

async function barrelSource(): Promise<string> {
	return readFile(`${REPO_ROOT}/src/verify/index.ts`, "utf8");
}

function assertObservationalBarrel(sourceText: string): void {
	assert.doesNotMatch(sourceText, /createVerifier/);
	assert.doesNotMatch(sourceText, /AuthorityVerifier/);
	assert.doesNotMatch(sourceText, /internal\.js/);
	assert.doesNotMatch(sourceText, /\b(?:import|export)\s*\(/);
	assert.doesNotMatch(sourceText, /Object\.defineProperty/);
}

const REVIEWED_PUBLIC_EXPORTS = [
	"DEFAULT_MAX_OUTPUT_BYTES", "DEFAULT_TIMEOUT_MS", "MAX_INPUT_BYTES", "confirmationLine", "createObservationalVerifier",
	"decodeVerificationCacheUpdate", "evidenceKind", "inspectTree", "isCompleteChecklist", "isCriterionPassed", "isNodePassed",
	"isObservedNodePassed", "makeCacheUpdate", "monitorTree", "observeVerificationResult", "resolveSpecPath", "runAgent", "runCommand",
	"runUser", "userChallenge", "verificationFailures", "verifyChecklist", "verifyNode", "verifyNodeAndCache", "verifyTreeUnchanged",
].sort();

function objectValue(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	return value as Record<string, unknown>;
}

function callable(value: unknown): (...args: unknown[]) => unknown {
	assert.equal(typeof value, "function");
	return value as (...args: unknown[]) => unknown;
}

function invoke(value: unknown, receiver: unknown, ...args: unknown[]): unknown {
	return Reflect.apply(callable(value), receiver, args);
}

function assertRejectedByEveryAuthorityPredicate(authority: object, value: unknown, label: string): void {
	for (const [predicate, kind] of [["isCriterionPassed", "passed criterion"], ["isCompleteChecklist", "complete checklist"], ["isNodePassed", "passed node"], ["isCacheUpdate", "cache update"]] as const) {
		assert.equal(invoke(Reflect.get(authority, predicate), authority, value), false, `${label} was accepted as a ${kind}`);
	}
}

function assertObservationalValueGraph(authority: object, value: unknown, label: string, seen = new Set<object>()): void {
	assertRejectedByEveryAuthorityPredicate(authority, value, label);
	if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const memberLabel = typeof key === "symbol" ? `${label}[${String(key)}]` : `${label}.${key}`;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		assert.ok(descriptor, `${memberLabel} must have an own property descriptor`);
		assert.ok("value" in descriptor, `${memberLabel} must not be an accessor`);
		assertObservationalValueGraph(authority, descriptor.value, memberLabel, seen);
	}
}

function assertObservedResultFromAuthority(surface: object, authority: object, value: unknown, label: string): Record<string, unknown> {
	const result = objectValue(value);
	assertObservationalValueGraph(authority, result, label);
	assert.equal(result.outcome, "passed", `${label} must preserve the authority result outcome`);
	assert.equal(invoke(Reflect.get(surface, "isObservedNodePassed"), undefined, result), true, `${label} must be an observed node`);
	assertRejectedByEveryAuthorityPredicate(authority, result, `${label} node`);
	assert.ok(Array.isArray(result.criteria) && result.criteria.length > 0, `${label} must retain criterion results`);
	const criterion = result.criteria[0];
	assert.ok(criterion, `${label} must retain its first criterion result`);
	assertRejectedByEveryAuthorityPredicate(authority, criterion, `${label} criterion`);
	const checklist = objectValue(result.checklist);
	assertRejectedByEveryAuthorityPredicate(authority, checklist, `${label} checklist`);
	return result;
}

function assertObservedCacheFromAuthority(surface: object, authority: object, value: unknown, label: string): void {
	const cache = objectValue(value);
	assertObservationalValueGraph(authority, cache, label);
	assertObservedResultFromAuthority(surface, authority, cache.record, `${label} record`);
}

interface SurfaceProbeOptions {
	readonly observation: { readonly session?: SessionReader; readonly hasUI?: boolean; readonly sessionManager?: SessionReader };
	readonly authority: VerifierCapabilities;
}

async function authorityPair(request: object, capabilities: VerifierCapabilities): Promise<{ authority: ReturnType<typeof createVerifier>; pair: Awaited<ReturnType<ReturnType<typeof createVerifier>["verifyNodeAndCache"]>> }> {
	const authority = createVerifier(capabilities);
	const pair = await authority.verifyNodeAndCache(request as Parameters<typeof authority.verifyNodeAndCache>[0]);
	assert.equal(pair.result.outcome, "passed", "authority fixture must produce a genuine passed result");
	assert.ok(pair.cacheUpdate, "authority fixture must produce a genuine cache update");
	return { authority, pair };
}

async function assertReviewedPublicSurface(surface: object, request: object, options: SurfaceProbeOptions, originatingAuthority: object = createVerifier(options.authority)): Promise<void> {
	assert.deepEqual(Object.keys(surface).sort(), REVIEWED_PUBLIC_EXPORTS);
	const authority = objectValue(originatingAuthority);
	for (const name of REVIEWED_PUBLIC_EXPORTS) assertObservationalValueGraph(authority, Reflect.get(surface, name), `public export ${name}`);
	assert.equal(Reflect.get(surface, "DEFAULT_MAX_OUTPUT_BYTES"), 1_048_576);
	assert.equal(Reflect.get(surface, "DEFAULT_TIMEOUT_MS"), 30_000);
	assert.equal(Reflect.get(surface, "MAX_INPUT_BYTES"), 8_388_608);

	const requestValue = objectValue(request);
	const target = objectValue(requestValue.target);
	const factory = invoke(Reflect.get(surface, "createObservationalVerifier"), undefined, options.observation);
	const observationalVerifier = objectValue(factory);
	assertObservationalValueGraph(authority, observationalVerifier, "createObservationalVerifier return");
	const observationalTree = await invoke(observationalVerifier.inspectTarget, observationalVerifier, target);
	assertObservationalValueGraph(authority, observationalTree, "createObservationalVerifier.inspectTarget return");
	const result = objectValue(await invoke(observationalVerifier.verifyNode, observationalVerifier, request));
	assert.equal(result.outcome, "passed", "the reviewed observational verifier must still execute the probe");
	const criteria = result.criteria;
	assert.ok(Array.isArray(criteria) && criteria.length > 0, "the observational probe must produce a criterion result");
	const criterion = criteria[0];
	assert.ok(criterion, "the observational probe must produce its first criterion result");
	const cache = objectValue(await invoke(observationalVerifier.verifyNodeAndCache, observationalVerifier, request));
	assert.ok(cache.cacheUpdate, "the observational probe must produce a cache observation");
	assertRejectedByEveryAuthorityPredicate(observationalVerifier, criterion, "observational criterion result");
	assertRejectedByEveryAuthorityPredicate(observationalVerifier, result, "observational node result");
	assertRejectedByEveryAuthorityPredicate(observationalVerifier, result.checklist, "observational checklist result");
	assertRejectedByEveryAuthorityPredicate(observationalVerifier, cache.cacheUpdate, "observational cache result");
	assert.equal(invoke(Reflect.get(surface, "isObservedNodePassed"), undefined, result), true, "the public constructor result must remain an observed node");

	const authorityCache = objectValue(await invoke(Reflect.get(authority, "verifyNodeAndCache"), authority, request));
	const authorityResult = objectValue(authorityCache.result);
	assert.equal(invoke(Reflect.get(authority, "isNodePassed"), authority, authorityResult), true, "the authority verifier must produce a genuine passed node");
	const authorityCriterion = Array.isArray(authorityResult.criteria) ? authorityResult.criteria[0] : undefined;
	assert.ok(authorityCriterion, "the authority verifier must produce a genuine criterion");
	assert.equal(invoke(Reflect.get(authority, "isCriterionPassed"), authority, authorityCriterion), true, "the authority verifier must brand its criterion");
	assert.equal(invoke(Reflect.get(authority, "isCompleteChecklist"), authority, authorityResult.checklist), true, "the authority verifier must brand its checklist");
	const authorityCacheUpdate = objectValue(authorityCache.cacheUpdate);
	assert.equal(invoke(Reflect.get(authority, "isCacheUpdate"), authority, authorityCacheUpdate), true, "the authority verifier must brand its cache update");

	assertObservedResultFromAuthority(surface, authority, result, "the observational constructor result");
	assertObservationalValueGraph(authority, cache, "createObservationalVerifier.verifyNodeAndCache return");
	assertObservedResultFromAuthority(surface, authority, cache.result, "the observational constructor cache-pair result");
	assertObservedCacheFromAuthority(surface, authority, cache.cacheUpdate, "the observational constructor cache result");
	for (const [predicate, authorityValue] of [["isCriterionPassed", authorityCriterion], ["isCompleteChecklist", authorityResult.checklist], ["isNodePassed", authorityResult], ["isCacheUpdate", authorityCacheUpdate]] as const) {
		const predicateResult = invoke(Reflect.get(observationalVerifier, predicate), observationalVerifier, authorityValue);
		assert.equal(predicateResult, false, `createObservationalVerifier.${predicate} must reject authority`);
		assertObservationalValueGraph(authority, predicateResult, `createObservationalVerifier.${predicate} return`);
	}
	const constructorFailures = invoke(observationalVerifier.verificationFailures, observationalVerifier, result);
	assertObservationalValueGraph(authority, constructorFailures, "createObservationalVerifier.verificationFailures return");

	const directResult = objectValue(await invoke(Reflect.get(surface, "verifyNode"), undefined, request));
	assertObservationalValueGraph(authority, directResult, "the public verifyNode result");
	assert.equal(directResult.outcome, "failed", "the legacy public verifyNode route has no session authority");
	const directCache = objectValue(await invoke(Reflect.get(surface, "verifyNodeAndCache"), undefined, request));
	assertObservationalValueGraph(authority, directCache, "public verifyNodeAndCache return");
	assert.equal(objectValue(directCache.result).outcome, "failed", "the legacy public verifyNodeAndCache route has no session authority");
	assert.ok(directCache.cacheUpdate, "the legacy public route still returns an observation");
	const observed = objectValue(await invoke(Reflect.get(surface, "observeVerificationResult"), undefined, authorityResult));
	assertObservedResultFromAuthority(surface, authority, observed, "the observation adapter result");
	const madeCache = objectValue(invoke(Reflect.get(surface, "makeCacheUpdate"), undefined, "spec.yaml", authorityResult));
	assertObservedCacheFromAuthority(surface, authority, madeCache, "the cache adapter result");
	const decoded = objectValue(invoke(Reflect.get(surface, "decodeVerificationCacheUpdate"), undefined, authorityCacheUpdate));
	assertObservedCacheFromAuthority(surface, authority, decoded, "the decoder result");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "decodeVerificationCacheUpdate"), undefined, null), "invalid decoder return");

	const treeCheck = objectValue(await invoke(Reflect.get(surface, "inspectTree"), undefined, target.worktreePath, target.expectedCommit));
	assert.equal(treeCheck.ok, true, "public inspectTree must inspect the probe tree");
	assertObservationalValueGraph(authority, treeCheck, "inspectTree return");
	const failedTreeCheck = await invoke(Reflect.get(surface, "inspectTree"), undefined, "", "");
	assertObservationalValueGraph(authority, failedTreeCheck, "inspectTree failure return");
	const snapshot = objectValue(treeCheck.snapshot);
	const unchanged = await invoke(Reflect.get(surface, "verifyTreeUnchanged"), undefined, snapshot);
	assertObservationalValueGraph(authority, unchanged, "verifyTreeUnchanged return");
	const monitor = objectValue(await invoke(Reflect.get(surface, "monitorTree"), undefined, snapshot));
	if (monitor.ok !== true) assert.fail("public monitorTree must monitor the probe tree");
	try {
		assertObservationalValueGraph(authority, monitor, "monitorTree return");
		assertObservationalValueGraph(authority, invoke(monitor.changed, monitor), "monitorTree.changed return");
		assertObservationalValueGraph(authority, invoke(monitor.untrackedPaths, monitor), "monitorTree.untrackedPaths return");
		assertObservationalValueGraph(authority, await invoke(monitor.drain, monitor), "monitorTree.drain return");
		assertObservationalValueGraph(authority, invoke(monitor.monitoring, monitor), "monitorTree.monitoring return");
	} finally {
		assertObservationalValueGraph(authority, invoke(monitor.stop, monitor), "monitorTree.stop return");
	}
	const failedMonitor = await invoke(Reflect.get(surface, "monitorTree"), undefined, { identity: { kind: "unsupported" }, clean: true, gitPath: "/usr/bin/git" });
	assertObservationalValueGraph(authority, failedMonitor, "monitorTree failure return");

	const tree = objectValue(authorityResult.tree);
	const evidenceKind = invoke(Reflect.get(surface, "evidenceKind"), undefined, { kind: "command" });
	assertObservationalValueGraph(authority, evidenceKind, "evidenceKind return");
	const userInput = { evidence: { kind: "user", prompt: "surface" }, specPath: "spec.yaml", nodeId: "surface", criterionId: "A", tree };
	const challenge = invoke(Reflect.get(surface, "userChallenge"), undefined, userInput, "session");
	assertObservationalValueGraph(authority, challenge, "userChallenge return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "confirmationLine"), undefined, challenge), "confirmationLine return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "resolveSpecPath"), undefined, target.worktreePath, "@spec.yaml"), "resolveSpecPath return");
	assertObservationalValueGraph(authority, await invoke(Reflect.get(surface, "runCommand"), undefined, { evidence: { kind: "command", run: "true", expect: { exit: 0 } }, tree }), "runCommand return");
	assertObservationalValueGraph(authority, await invoke(Reflect.get(surface, "runAgent"), undefined, { evidence: { kind: "agent", agent: "reviewer", rubric: "review", inputs: [] }, tree }), "runAgent return");
	assertObservationalValueGraph(authority, await invoke(Reflect.get(surface, "runUser"), undefined, userInput), "runUser return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "verifyChecklist"), undefined, ["done"], [{ index: 0, done: true }], tree), "verifyChecklist complete return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "verifyChecklist"), undefined, ["todo"], [], tree), "verifyChecklist incomplete return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "verificationFailures"), undefined, result), "verificationFailures return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "isCriterionPassed"), undefined, authorityCriterion), "isCriterionPassed return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "isCompleteChecklist"), undefined, authorityResult.checklist), "isCompleteChecklist return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "isNodePassed"), undefined, authorityResult), "isNodePassed return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "isObservedNodePassed"), undefined, result), "isObservedNodePassed true return");
	assertObservationalValueGraph(authority, invoke(Reflect.get(surface, "isObservedNodePassed"), undefined, authorityResult), "isObservedNodePassed false return");
}

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await sourceFiles(entryPath));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
	}
	return files;
}

async function withSurfaceProbe(callback: (request: object, options: SurfaceProbeOptions) => Promise<void>, kind: "user" | "command" = "user"): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-surface-"));
	try {
		await writeFile(path.join(root, "tracked"), "clean\n");
		const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git(["init", "-q"]);
		git(["add", "."]);
		execFileSync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
		const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
		const userEvidence = { kind: "user" as const, prompt: "Confirm the surface signal." };
		const node = {
			id: "surface",
			task: "run",
			acceptance: [{ id: "A", statement: "signal", evidence: kind === "user" ? userEvidence : { kind: "command" as const, run: "printf signal", expect: { exit: 0, output_includes: "signal" } } }],
		};
		const request = { node, specPath: "spec.yaml", target: { worktreePath: root, expectedCommit: commit } };
		if (kind === "user") {
			const sessionId = "surface-session";
			const sessionFile = path.join(os.tmpdir(), `pi-work-surface-session-${process.pid}-${Date.now()}.jsonl`);
			const challenge = userChallenge({ evidence: userEvidence, specPath: request.specPath, nodeId: node.id, criterionId: "A", tree: { kind: "git", worktreePath: root, resolvedCommit: commit } }, sessionId);
			const session: SessionReader = {
				getSessionId: () => sessionId,
				getSessionFile: () => sessionFile,
				getBranch: () => [{ id: "surface-confirmation", type: "message", timestamp: "2026-08-14T00:00:00.000Z", message: { role: "user", content: confirmationLine(challenge) } }],
			};
			try {
				await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n${JSON.stringify({ id: "surface-confirmation", type: "message", timestamp: "2026-08-14T00:00:00.000Z", message: { role: "user", content: confirmationLine(challenge) } })}\n`);
				await callback(request, { observation: { session, hasUI: false, sessionManager: session }, authority: { hasUI: false, sessionManager: session } });
			} finally {
				await rm(sessionFile, { force: true });
			}
		} else {
			await callback(request, { observation: {}, authority: { hasUI: false } });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("public verify barrel exposes no authority constructor, including against a re-export mutant", async () => {
	await withSurfaceProbe(async (request, options) => {
		await assertReviewedPublicSurface(publicBarrel, request, options);
		const identityObservationMutant = {
			...publicBarrel,
			observeVerificationResult: (value: Parameters<typeof publicBarrel.observeVerificationResult>[0]) => value,
		};
		await assert.rejects(() => assertReviewedPublicSurface(identityObservationMutant, request, options));
		const authorityPreservingCacheMutant = {
			...publicBarrel,
			makeCacheUpdate: (specPath: string, result: Parameters<typeof publicBarrel.makeCacheUpdate>[1]) => ({
				kind: "verification-cache-update" as const,
				specPath,
				nodeId: result.nodeId,
				recordedAt: result.recordedAt,
				tree: result.tree,
				record: result,
			}),
		};
		await assert.rejects(() => assertReviewedPublicSurface(authorityPreservingCacheMutant, request, options));
		const decoderIdentityMutant = {
			...publicBarrel,
			decodeVerificationCacheUpdate: (value: Parameters<typeof publicBarrel.decodeVerificationCacheUpdate>[0]) => value,
		};
		await assert.rejects(() => assertReviewedPublicSurface(decoderIdentityMutant, request, options));
		const { authority: constructorMixedAuthority } = await authorityPair(request, options.authority);
		const mixedConstructorCachePairMutant = {
			...publicBarrel,
			createObservationalVerifier: (...args: Parameters<typeof publicBarrel.createObservationalVerifier>) => {
				const observedVerifier = publicBarrel.createObservationalVerifier(...args);
				const authorityVerifier = constructorMixedAuthority;
				return {
					...observedVerifier,
					verifyNodeAndCache: async (probe: Parameters<typeof observedVerifier.verifyNodeAndCache>[0]) => {
						const authorityPair = await authorityVerifier.verifyNodeAndCache(probe);
						const observedPair = await observedVerifier.verifyNodeAndCache(probe);
						return { result: authorityPair.result, cacheUpdate: observedPair.cacheUpdate };
					},
				};
			},
		};
		await assert.rejects(() => assertReviewedPublicSurface(mixedConstructorCachePairMutant, request, options, constructorMixedAuthority), /verifyNodeAndCache return\.result was accepted as a passed node/);
		const { authority: publicMixedAuthority } = await authorityPair(request, options.authority);
		const mixedPublicCachePairMutant = {
			...publicBarrel,
			verifyNodeAndCache: async (probe: Parameters<typeof publicBarrel.verifyNodeAndCache>[0]) => {
				const authorityPair = await publicMixedAuthority.verifyNodeAndCache(probe);
				const observedPair = await publicBarrel.verifyNodeAndCache(probe);
				return { result: authorityPair.result, cacheUpdate: observedPair.cacheUpdate };
			},
		};
		await assert.rejects(() => assertReviewedPublicSurface(mixedPublicCachePairMutant, request, options, publicMixedAuthority), /public verifyNodeAndCache return\.result was accepted as a passed node/);

		const { authority: uncheckedMemberAuthority } = await authorityPair(request, options.authority);
		const uncheckedPairMemberMutant = {
			...publicBarrel,
			verifyNodeAndCache: async (probe: Parameters<typeof publicBarrel.verifyNodeAndCache>[0]) => {
				const observedPair = await publicBarrel.verifyNodeAndCache(probe);
				const authorityPair = await uncheckedMemberAuthority.verifyNodeAndCache(probe);
				return { ...observedPair, unchecked: authorityPair.result };
			},
		};
		await assert.rejects(() => assertReviewedPublicSurface(uncheckedPairMemberMutant, request, options, uncheckedMemberAuthority), /public verifyNodeAndCache return\.unchecked was accepted as a passed node/);
		const { authority: uncheckedNestedAuthority } = await authorityPair(request, options.authority);
		const uncheckedNestedValueMutant = {
			...publicBarrel,
			makeCacheUpdate: (specPath: string, result: Parameters<typeof publicBarrel.makeCacheUpdate>[1]) => ({
				...publicBarrel.makeCacheUpdate(specPath, result),
				metadata: { criterion: result.criteria[0] },
			}),
		};
		await assert.rejects(() => assertReviewedPublicSurface(uncheckedNestedValueMutant, request, options, uncheckedNestedAuthority), /cache adapter result\.metadata\.criterion was accepted as a passed criterion/);
		const { authority: nestedAuthorityRecord } = await authorityPair(request, options.authority);
		const observationalContainerMutant = {
			...publicBarrel,
			decodeVerificationCacheUpdate: (value: Parameters<typeof publicBarrel.decodeVerificationCacheUpdate>[0]) => {
				const observedCache = publicBarrel.decodeVerificationCacheUpdate(value);
				if (!observedCache) return observedCache;
				return { ...observedCache, diagnostics: { authorityRecord: objectValue(value).record } };
			},
		};
		await assert.rejects(() => assertReviewedPublicSurface(observationalContainerMutant, request, options, nestedAuthorityRecord), /decoder result\.diagnostics\.authorityRecord was accepted as a passed node/);

		const { authority: callableOwnedAuthority, pair: callableOwnedPair } = await authorityPair(request, options.authority);
		const callableWithAuthority = Object.assign(
			(probe: Parameters<typeof publicBarrel.verifyNode>[0]) => publicBarrel.verifyNode(probe),
			{ leaked: callableOwnedPair.result },
		);
		const callableOwnedAuthorityMutant = { ...publicBarrel, verifyNode: callableWithAuthority };
		await assert.rejects(() => assertReviewedPublicSurface(callableOwnedAuthorityMutant, request, options, callableOwnedAuthority), /public export verifyNode\.leaked was accepted as a passed node/);
		let accessorInvoked = false;
		const accessorWithAuthority = (probe: Parameters<typeof publicBarrel.verifyNode>[0]) => publicBarrel.verifyNode(probe);
		Object.defineProperty(accessorWithAuthority, "leaked", {
			enumerable: true,
			get: () => {
				accessorInvoked = true;
				return callableOwnedPair.result;
			},
		});
		const accessorMutant = { ...publicBarrel, verifyNode: accessorWithAuthority };
		await assert.rejects(() => assertReviewedPublicSurface(accessorMutant, request, options, callableOwnedAuthority), /public export verifyNode\.leaked must not be an accessor/);
		assert.equal(accessorInvoked, false, "structural enumeration must not invoke accessors");
		const { authority: monitorCleanupAuthority, pair: monitorAuthorityPair } = await authorityPair(request, options.authority);
		let monitorStopped = false;
		const monitorCleanupMutant = {
			...publicBarrel,
			monitorTree: async (snapshot: Parameters<typeof publicBarrel.monitorTree>[0]) => {
				const monitor = await publicBarrel.monitorTree(snapshot);
				if (!monitor.ok) return monitor;
				return {
					...monitor,
					leaked: monitorAuthorityPair.result,
					stop: () => {
						monitorStopped = true;
						monitor.stop();
					},
				};
			},
		};
		await assert.rejects(() => assertReviewedPublicSurface(monitorCleanupMutant, request, options, monitorCleanupAuthority), /monitorTree return\.leaked was accepted as a passed node/);
		assert.equal(monitorStopped, true, "monitorTree must stop after structural validation rejects its return graph");
		assert.equal("createVerifier" in publicBarrel, false);
		const barrel = await barrelSource();
		assertObservationalBarrel(barrel);
		const directReExportMutant = `${barrel}\nexport { createVerifier } from "./internal.js";\n`;
		assert.throws(() => assertObservationalBarrel(directReExportMutant));
		const computedName = ["create", "Verifier"].join("");
		const computedKeyMutant = { ...publicBarrel, [computedName]: createVerifier };
		await assert.rejects(() => assertReviewedPublicSurface(computedKeyMutant, request, options));
		const wrapperName = ["make", "Verifier"].join("");
		const aliasedWrapperMutant = { ...publicBarrel, [wrapperName]: (...args: Parameters<typeof createVerifier>) => createVerifier(...args) };
		await assert.rejects(() => assertReviewedPublicSurface(aliasedWrapperMutant, request, options));

		const internalNamespace: Record<string, typeof createVerifier> = { createVerifier };
		const sameKeyComputedAuthorityMutant = {
			...publicBarrel,
			createObservationalVerifier: internalNamespace[["create", "Verifier"].join("")],
		};
		await assert.rejects(() => assertReviewedPublicSurface(sameKeyComputedAuthorityMutant, request, options));
		const sameKeyAliasedAuthorityMutant = {
			...publicBarrel,
			createObservationalVerifier: (options: { hasUI: boolean }) => createVerifier(options),
		};
		await assert.rejects(() => assertReviewedPublicSurface(sameKeyAliasedAuthorityMutant, request, options));
		const sameKeyGetterMutant = { ...publicBarrel };
		Object.defineProperty(sameKeyGetterMutant, "createObservationalVerifier", { configurable: true, enumerable: true, get: () => createVerifier });
		await assert.rejects(() => assertReviewedPublicSurface(sameKeyGetterMutant, request, options));
		const { authority: sameKeyFactoryAuthority } = await authorityPair(request, options.authority);
		const sameKeyFactoryReturningMutant = { ...publicBarrel, createObservationalVerifier: () => sameKeyFactoryAuthority };
		await assert.rejects(() => assertReviewedPublicSurface(sameKeyFactoryReturningMutant, request, options, sameKeyFactoryAuthority), /observational criterion result was accepted as a passed criterion/);
		const directAuthorityRouteMutant = {
			...publicBarrel,
			verifyNode: (probe: Parameters<typeof publicBarrel.verifyNode>[0]) => createVerifier(options.authority).verifyNode(probe),
		};
		await assert.rejects(() => assertReviewedPublicSurface(directAuthorityRouteMutant, request, options));

		const starReExportMutant = `${barrel}\nexport * from "./internal.js";\n`;
		assert.throws(() => assertObservationalBarrel(starReExportMutant));
		const dynamicReExportMutant = `${barrel}\nconst internal = await import("./internal.js");\nexport const createObservationalVerifier = () => internal[["create", "Verifier"].join("")]({ hasUI: false });\n`;
		assert.throws(() => assertObservationalBarrel(dynamicReExportMutant));
		const propertyDefinitionMutant = `${barrel}\nObject.defineProperty(publicBarrel, "createObservationalVerifier", { get: () => createVerifier });\n`;
		assert.throws(() => assertObservationalBarrel(propertyDefinitionMutant));
		const factoryReturningSourceMutant = `${barrel}\nexport const createObservationalVerifier = () => createVerifier({ hasUI: false });\n`;
		assert.throws(() => assertObservationalBarrel(factoryReturningSourceMutant));
	});
});

test("host integration: public verification routes produce successful observations", { skip: systemdPrerequisite.available ? false : systemdPrerequisite.reason }, async () => {
	await withSurfaceProbe(async (request) => {
		const result = await publicBarrel.verifyNode(request as Parameters<typeof publicBarrel.verifyNode>[0]);
		assert.equal(result.outcome, "passed");
		const cached = await publicBarrel.verifyNodeAndCache(request as Parameters<typeof publicBarrel.verifyNodeAndCache>[0]);
		assert.equal(cached.result.outcome, "passed");
		assert.ok(cached.cacheUpdate);
	}, "command");
});

test("only the work-verify composition root imports the authority factory", async () => {
	const sources = new Map<string, string>();
	for (const file of await sourceFiles(path.join(REPO_ROOT, "src"))) {
		const text = await readFile(file, "utf8");
		sources.set(path.relative(REPO_ROOT, file), text);
	}
	const expectedImports = new Map([
		["src/tools/work-verify.ts", "{ createVerifier, type VerificationTarget }"],
		["src/verify/verify-node.ts", "{ createObservationalVerifier, verificationFailures, type ObservationalVerifier, type ObservationalVerifierAdapters, type VerificationTarget, type VerifyNodeOptions, type VerifyNodeRequest }"],
	]);
	const importers = [...sources.entries()].filter(([, sourceText]) => sourceText.includes("internal.js")).map(([file]) => file).sort();
	assert.deepEqual(importers, [...expectedImports.keys()].sort());
	for (const [file, expectedImport] of expectedImports) {
		const sourceText = sources.get(file);
		assert.ok(sourceText, `missing source for ${file}`);
		assert.equal((sourceText.match(/internal\.js/g) ?? []).length, 1, `${file} has an unreviewed internal.js route`);
		const imports = [...sourceText.matchAll(/\bimport\s+([^;]*?)\s+from\s+["'][^"']*internal\.js["']\s*;?/g)].map((match) => match[1].replace(/\s+/g, " ").replace(/,\s*}/g, " }").trim());
		assert.deepEqual(imports, [expectedImport], `${file} must use its exact reviewed internal.js import`);
	}
	const factoryConsumers = [...sources.entries()]
		.filter(([, sourceText]) => /\bcreateVerifier\b/.test(sourceText))
		.map(([file]) => file)
		.filter((file) => file !== "src/verify/internal.ts")
		.sort();
	assert.deepEqual(factoryConsumers, ["src/tools/work-verify.ts"]);
	assert.equal((sources.get("src/tools/work-verify.ts")?.match(/\bcreateVerifier\b/g) ?? []).length, 2);
	assert.doesNotMatch(sources.get("src/verify/verify-node.ts") ?? "", /\bcreateVerifier\b/);
});

test("trusted state has no module-level registry or constructor door", async () => {
	const internal = await source();
	assert.doesNotMatch(internal, /^const \w+Objects = new WeakSet<object>\(\);$/m);
	assert.equal((internal.match(/new WeakSet<object>\(\);/g) ?? []).length, 4);
	assert.match(internal, /function makeAuthorityVerifier\(capabilities: VerifierCapabilities\)/);
	assert.doesNotMatch(internal, /export\s+(?:async\s+)?function\s+create(?:PassedCriterion|CompleteChecklist|PassedNode|CacheUpdate)/);
	assert.doesNotMatch(internal, /export\s*\{[^}]*create(?:PassedCriterion|CompleteChecklist|PassedNode|CacheUpdate)/s);
	assert.doesNotMatch(internal, /\bpassedCriterionObjects\[\s*["']add["']\s*\]/);
});

test("closure-private trust is verifier-specific", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-work-trust-"));
	try {
		await writeFile(path.join(root, "tracked"), "clean\n");
		const git = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git(["init", "-q"]); git(["add", "."]); execFileSync("git", ["-c", "user.name=pi-work", "-c", "user.email=pi-work@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
		const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], { cwd: root, encoding: "utf8" }).trim();
		const user = { kind: "user" as const, prompt: "Confirm the signal." };
		const session = { getSessionId: () => "session-1", getSessionFile: () => undefined, getBranch: () => [] };
		const request = { node: { id: "n", task: "run", acceptance: [{ id: "A", statement: "signal", evidence: user }] }, specPath: "spec.yaml", target: { worktreePath: root, expectedCommit: commit } };
		const first = createVerifier({ hasUI: true, sessionManager: session, confirm: async () => true });
		const second = createVerifier({ hasUI: true, sessionManager: session, confirm: async () => true });
		const result = await first.verifyNode(request);
		assert.equal(first.isNodePassed(result), true);
		assert.equal(second.isNodePassed(result), false);
		if (result.outcome === "passed") {
			assert.equal(first.isCriterionPassed(result.criteria[0]), true);
			assert.equal(second.isCriterionPassed(result.criteria[0]), false);
			assert.equal(first.isCompleteChecklist(result.checklist), true);
			assert.equal(second.isCompleteChecklist(result.checklist), false);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
