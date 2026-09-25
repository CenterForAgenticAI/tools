import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Extension,
	ExtensionRuntime,
	LoadExtensionsResult,
	SourceInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import {
	type ExtensionToolGrant,
	ToolSelectorDiagnosticCode,
	toolSelectorDiagnostic,
} from "./tool-selector.js";

/** Stable, environment-independent identity derived for a loaded extension. */
export interface PortableExtensionIdentity {
	packageName?: string;
	/** Canonical package source (`npm:<name>` or ref-independent `git:<host>/<path>`). */
	source?: string;
	/** POSIX path from the nearest package root to this extension entrypoint. */
	entrypoint?: string;
	packageRoot?: string;
	/** Compatibility fallback. Never preferred over package/source selectors. */
	resolvedPath: string;
}

/** Package identities trusted to provide pi-delegate's own delegate-family tools. */
export const PI_DELEGATE_PACKAGE_NAMES = [
	"@caair/pi-delegate",
	"@centerforagenticai/pi-delegate",
] as const;
/** Internal canonical identity retained for emitted selectors and compatibility. */
export const PI_DELEGATE_PACKAGE_NAME = PI_DELEGATE_PACKAGE_NAMES[0];
export const PI_DELEGATE_NPM_SOURCES: readonly string[] = PI_DELEGATE_PACKAGE_NAMES.map((name) => `npm:${name}`);
const PI_DELEGATE_PACKAGE_NAME_SET = new Set<string>(PI_DELEGATE_PACKAGE_NAMES);
const PI_DELEGATE_NPM_SOURCE_SET = new Set<string>(PI_DELEGATE_NPM_SOURCES);
const PI_DELEGATE_GIT_SOURCE = "git:gitlab.caair.io/intel/pi-delegate";

export interface ExtensionPolicyCandidate {
	path: string;
	sourceInfo: SourceInfo;
	identity: PortableExtensionIdentity;
}

const IDENTITY = Symbol.for("pi-delegate.portable-extension-identity");
type IdentifiedExtension = Extension & { [IDENTITY]?: PortableExtensionIdentity };
type DefaultResourceLoaderOptions = NonNullable<
	ConstructorParameters<typeof DefaultResourceLoader>[0]
>;

function posix(value: string): string {
	return value.replaceAll(path.sep, "/");
}

function stripGitRef(value: string): string {
	const slash = value.lastIndexOf("/");
	const at = value.lastIndexOf("@");
	return at > slash ? value.slice(0, at) : value;
}

/** Normalize npm sources to a ref/version-independent package identity. */
export function normalizeNpmIdentity(value: string): string | undefined {
	const raw = value.trim();
	if (!raw.startsWith("npm:")) return undefined;
	const spec = raw.slice(4);
	if (!spec) return undefined;
	const versionAt = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
	const name = versionAt >= 0 ? spec.slice(0, versionAt) : spec;
	return name ? `npm:${name}` : undefined;
}

/**
 * Normalize Git SSH/HTTPS/shorthand forms to `git:<host>/<path>`, without
 * `.git` or a pinned ref. Host aliases are opt-in: aliases are deployment
 * configuration, not a trust assertion.
 */
export function normalizeGitIdentity(
	value: string,
	hostAliases: Readonly<Record<string, string>> = {},
): string | undefined {
	let raw = value.trim();
	if (!raw) return undefined;
	if (raw.startsWith("git:")) raw = raw.slice(4);
	if (raw.startsWith("github:")) raw = `github.com/${raw.slice("github:".length)}`;

	let host: string | undefined;
	let repositoryPath: string | undefined;
	const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
	if (scp && !raw.includes("://")) {
		host = scp[1];
		repositoryPath = scp[2];
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		try {
			const parsed = new URL(raw);
			host = parsed.hostname;
			repositoryPath = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const withoutRef = stripGitRef(raw);
		const slash = withoutRef.indexOf("/");
		if (slash <= 0) return undefined;
		host = withoutRef.slice(0, slash);
		repositoryPath = withoutRef.slice(slash + 1);
	}

	if (!host || !repositoryPath) return undefined;
	host = (hostAliases[host] ?? host).toLowerCase();
	repositoryPath = stripGitRef(repositoryPath)
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	if (!repositoryPath) return undefined;
	return `git:${host}/${repositoryPath}`;
}

interface PackageManifestIdentity {
	root: string;
	name?: string;
	repository?: string;
}

function readManifestIdentity(file: string): PackageManifestIdentity | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
		const repositoryValue = parsed.repository;
		const repository =
			typeof repositoryValue === "string"
				? repositoryValue
				: repositoryValue && typeof repositoryValue === "object" && !Array.isArray(repositoryValue)
					? (repositoryValue as { url?: unknown }).url
					: undefined;
		return {
			root: path.dirname(file),
			...(typeof parsed.name === "string" && parsed.name.trim() ? { name: parsed.name } : {}),
			...(typeof repository === "string" && repository.trim()
				? { repository }
				: {}),
		};
	} catch {
		return undefined;
	}
}

function nearestPackage(entryPath: string, baseDir?: string): PackageManifestIdentity | undefined {
	// The extension entrypoint owns package discovery. Pi's sourceInfo.baseDir
	// may be the agent directory for auto-discovered extensions, which is a
	// provenance root rather than the extension package root.
	const entryExists = fs.existsSync(entryPath);
	let current = path.resolve(
		entryExists && fs.statSync(entryPath).isDirectory()
			? entryPath
			: entryExists
				? path.dirname(entryPath)
				: baseDir && fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()
					? baseDir
					: path.dirname(entryPath),
	);
	while (true) {
		const manifest = readManifestIdentity(path.join(current, "package.json"));
		if (manifest) return manifest;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function gitOrigin(root: string): string | undefined {
	try {
		const output = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		}).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

function canonicalSource(
	sourceInfo: SourceInfo,
	manifest: PackageManifestIdentity | undefined,
): string | undefined {
	const npm = normalizeNpmIdentity(sourceInfo.source);
	if (npm) {
		if (PI_DELEGATE_NPM_SOURCE_SET.has(npm) && !isPiDelegatePackageIdentifier(sourceInfo.source)) {
			return sourceInfo.source;
		}
		return npm;
	}
	if (/^(?:git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(sourceInfo.source)) {
		const git = normalizeGitIdentity(sourceInfo.source);
		if (git) {
			if (git === PI_DELEGATE_GIT_SOURCE && sourceInfo.source !== sourceInfo.source.trim()) {
				return sourceInfo.source;
			}
			return git;
		}
	}
	// Local checkouts deliberately prefer declared repository metadata over
	// whatever remote happens to be configured on this machine.
	const declaredSource = manifest?.repository;
	const declared = declaredSource ? normalizeGitIdentity(declaredSource) : undefined;
	if (declared) {
		if (declared === PI_DELEGATE_GIT_SOURCE && declaredSource !== declaredSource.trim()) return declaredSource;
		return declared;
	}
	const origin = manifest ? gitOrigin(manifest.root) : undefined;
	return origin ? normalizeGitIdentity(origin) : undefined;
}

/** Derive a portable identity from Pi provenance plus nearest package/Git metadata. */
export function derivePortableExtensionIdentity(
	resolvedPath: string,
	sourceInfo: SourceInfo,
): PortableExtensionIdentity {
	const absolutePath = path.resolve(resolvedPath);
	const manifest = nearestPackage(absolutePath, sourceInfo.baseDir);
	let entrypoint: string | undefined;
	if (manifest) {
		const relative = path.relative(manifest.root, absolutePath);
		if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
			entrypoint = posix(relative);
		}
	}
	const source = canonicalSource(sourceInfo, manifest);
	return {
		...(manifest?.name ? { packageName: manifest.name } : {}),
		...(source ? { source } : {}),
		...(entrypoint ? { entrypoint } : {}),
		...(manifest ? { packageRoot: manifest.root } : {}),
		resolvedPath: absolutePath,
	};
}

export function getPortableExtensionIdentity(
	extension: Extension,
): PortableExtensionIdentity | undefined {
	return (extension as IdentifiedExtension)[IDENTITY];
}

/** Ensure a loaded extension has the portable identity selected by policy. */
export function identifyLoadedExtension(extension: Extension): PortableExtensionIdentity {
	return identify(extension);
}

/** Resolve one loaded extension by the same identity rules as include/exclude policy. */
export function resolveLoadedExtensionBySelector(
	selector: string,
	extensions: readonly Extension[],
): { extension: Extension; identity: PortableExtensionIdentity } {
	const items = extensions.map((extension) => ({ extension, identity: identify(extension) }));
	const selected = resolveSelector(selector, items);
	return selected;
}

export interface ExtensionToolSelectorIdentity {
	extension: string;
	module?: string;
	tool?: string;
}

function selectorFailure(code: ToolSelectorDiagnosticCode, message: string): Error {
	return new Error(toolSelectorDiagnostic(code, message));
}

function samePackageOwner(
	left: PortableExtensionIdentity,
	right: PortableExtensionIdentity,
): boolean {
	return Boolean(
		left.packageRoot && left.packageName &&
		left.packageRoot === right.packageRoot &&
		left.packageName === right.packageName &&
		(!left.source || !right.source || left.source === right.source),
	);
}

function resolveOwnerGroup(
	owner: string,
	extensions: readonly Extension[],
): Array<{ extension: Extension; identity: PortableExtensionIdentity }> {
	const items = extensions.map((extension) => ({ extension, identity: identify(extension) }));
	const matches = items.filter((item) => selectorForms(item.identity).includes(owner.trim()));
	if (matches.length === 0) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.OWNER_NOT_FOUND,
			`owner ${JSON.stringify(owner)} was not found among loaded extensions`,
		);
	}
	const first = matches[0]!;
	if (matches.length > 1 && !matches.every((match) => samePackageOwner(first.identity, match.identity))) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.OWNER_AMBIGUOUS,
			`owner ${JSON.stringify(owner)} matches more than one loaded package: ${describeAlternatives(matches)}`,
		);
	}
	return matches;
}

/** Resolve and contain one declared `pi-delegate.modules` entrypoint. */
export function resolvePackageModuleEntrypoint(
	identity: PortableExtensionIdentity,
	moduleId: string,
): string {
	const root = identity.packageRoot;
	if (!root) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(moduleId)} cannot be resolved because its owner has no package root`,
		);
	}
	let configured: unknown;
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
		const delegate = manifest["pi-delegate"];
		const modules = delegate && typeof delegate === "object" && !Array.isArray(delegate)
			? (delegate as Record<string, unknown>).modules
			: undefined;
		configured = modules && typeof modules === "object" && !Array.isArray(modules)
			? (modules as Record<string, unknown>)[moduleId]
			: undefined;
	} catch {
		configured = undefined;
	}
	if (typeof configured !== "string" || !configured.trim()) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`owner ${JSON.stringify(identity.packageName ?? identity.source ?? root)} does not declare module ${JSON.stringify(moduleId)}`,
		);
	}
	const relative = configured.trim();
	if (path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(moduleId)} must use a package-relative entrypoint`,
		);
	}
	const candidate = path.resolve(root, relative);
	const lexicalRelative = path.relative(path.resolve(root), candidate);
	if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`)) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(moduleId)} escapes its owner package`,
		);
	}
	let realRoot: string;
	let realCandidate: string;
	try {
		realRoot = fs.realpathSync(root);
		realCandidate = fs.realpathSync(candidate);
	} catch {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(moduleId)} does not resolve to an existing entrypoint`,
		);
	}
	const realRelative = path.relative(realRoot, realCandidate);
	if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`)) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(moduleId)} resolves outside its owner package`,
		);
	}
	return realCandidate;
}

/** Verify the effective ToolInfo provider for one parsed extension grant. */
export function verifyToolGrantProvider(
	grant: ExtensionToolGrant,
	tool: Pick<ToolInfo, "name" | "sourceInfo">,
): void {
	if (grant.tool !== undefined && tool.name !== grant.tool) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.TOOL_UNDECLARED,
			`grant ${JSON.stringify(grant.authored)} does not declare tool ${JSON.stringify(tool.name)}`,
		);
	}
	const identity = derivePortableExtensionIdentity(tool.sourceInfo.path, tool.sourceInfo);
	const ownerMatches = isPiDelegateExtensionSelector(identity, grant.owner) ||
		portableExtensionIdentityMatchesSelector(identity, grant.owner);
	if (!ownerMatches) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.PROVIDER_MISMATCH,
			`tool ${JSON.stringify(tool.name)} is provided by ${JSON.stringify(describeQualified(identity))}, not ${JSON.stringify(grant.owner)}`,
		);
	}
	if (grant.module) {
		const entrypoint = resolvePackageModuleEntrypoint(identity, grant.module);
		if (canonicalPathKey(tool.sourceInfo.path) !== canonicalPathKey(entrypoint)) {
			throw selectorFailure(
				ToolSelectorDiagnosticCode.PROVIDER_MISMATCH,
				`tool ${JSON.stringify(tool.name)} is not provided by declared module ${JSON.stringify(grant.module)}`,
			);
		}
	}
}

/** Resolve a parsed tool selector to its verified loaded extension owner. */
export function resolveLoadedExtensionForToolSelector(
	selector: ExtensionToolSelectorIdentity,
	extensions: readonly Extension[],
): { extension: Extension; identity: PortableExtensionIdentity } {
	if (!selector.module) {
		try {
			return resolveLoadedExtensionBySelector(selector.extension, extensions);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code = /ambiguous/i.test(message)
				? ToolSelectorDiagnosticCode.OWNER_AMBIGUOUS
				: ToolSelectorDiagnosticCode.OWNER_NOT_FOUND;
			throw selectorFailure(code, message);
		}
	}
	const owners = resolveOwnerGroup(selector.extension, extensions);
	const entrypoint = resolvePackageModuleEntrypoint(owners[0]!.identity, selector.module);
	const matches = owners.filter(({ extension }) =>
		canonicalPathKey(extension.resolvedPath) === canonicalPathKey(entrypoint));
	if (matches.length !== 1) {
		throw selectorFailure(
			ToolSelectorDiagnosticCode.MODULE_UNKNOWN,
			`module ${JSON.stringify(selector.module)} does not identify one loaded extension entrypoint`,
		);
	}
	return matches[0]!;
}

function identify(extension: Extension): PortableExtensionIdentity {
	const existing = getPortableExtensionIdentity(extension);
	if (existing) return existing;
	const identity = derivePortableExtensionIdentity(extension.resolvedPath, extension.sourceInfo);
	Object.defineProperty(extension, IDENTITY, {
		value: identity,
		writable: false,
		enumerable: false,
		configurable: true,
	});
	return identity;
}

function assignIdentity(extension: Extension, identity: PortableExtensionIdentity): void {
	Object.defineProperty(extension, IDENTITY, {
		value: identity,
		writable: false,
		enumerable: false,
		configurable: true,
	});
}

function selectorForms(identity: PortableExtensionIdentity): string[] {
	const forms: string[] = [];
	if (identity.packageName) forms.push(identity.packageName);
	if (identity.source) forms.push(identity.source);
	forms.push(identity.resolvedPath, posix(identity.resolvedPath));
	if (identity.entrypoint) {
		if (identity.packageName) forms.push(`${identity.packageName}#${identity.entrypoint}`);
		if (identity.source) forms.push(`${identity.source}#${identity.entrypoint}`);
	}
	// `pi-delegate` is an input convenience alias, but only the canonical
	// package identity may contribute it to selector matching.
	if (isPiDelegateExtensionIdentity(identity)) forms.push("pi-delegate");
	return [...new Set(forms)];
}

/** Match one already-derived identity without performing ambiguity resolution. */
export function portableExtensionIdentityMatchesSelector(
	identity: PortableExtensionIdentity,
	selector: string,
): boolean {
	return selectorForms(identity).includes(selector.trim());
}

/** Recognize one exact trusted package or npm-source spelling, including a versioned npm source. */
export function isPiDelegatePackageIdentifier(value: string): boolean {
	if (value !== value.trim()) return false;
	const npmSource = normalizeNpmIdentity(value);
	return PI_DELEGATE_PACKAGE_NAME_SET.has(value) ||
		(npmSource !== undefined && PI_DELEGATE_NPM_SOURCE_SET.has(npmSource));
}

/**
 * Recognize the loaded pi-delegate package by portable identity, not by a
 * directory or extension filename. A package named merely `pi-delegate` is
 * not trusted: it is the input convenience alias, not the owner identity.
 */
export function isPiDelegateExtensionIdentity(identity: PortableExtensionIdentity): boolean {
	return (identity.packageName !== undefined && isPiDelegatePackageIdentifier(identity.packageName)) ||
		(identity.source !== undefined && isPiDelegatePackageIdentifier(identity.source)) ||
		identity.source === PI_DELEGATE_GIT_SOURCE;
}

/**
 * Match a selector against pi-delegate's trusted identity. `pi-delegate` is
 * accepted only as an alias after the loaded identity has proved ownership.
 */
export function isPiDelegateExtensionSelector(
	identity: PortableExtensionIdentity,
	selector: string,
): boolean {
	if (!isPiDelegateExtensionIdentity(identity)) return false;
	const trimmed = selector.trim();
	if (trimmed.toLowerCase() === "pi-delegate") return true;
	if (isPiDelegatePackageIdentifier(trimmed)) return true;
	return portableExtensionIdentityMatchesSelector(identity, trimmed);
}

/** Recognize pi-intercom without relying on a machine-specific entrypoint path. */
export function isPiIntercomExtensionIdentity(identity: PortableExtensionIdentity): boolean {
	return (
		identity.packageName === "pi-intercom" ||
		identity.source === "npm:pi-intercom" ||
		identity.source?.endsWith("/pi-intercom") === true
	);
}

/** Prefer a source-qualified form in diagnostics so ambiguity is actionable. */
function describeQualified(identity: PortableExtensionIdentity): string {
	if (identity.source && identity.entrypoint) return `${identity.source}#${identity.entrypoint}`;
	if (identity.source) return identity.source;
	if (identity.packageName && identity.entrypoint) return `${identity.packageName}#${identity.entrypoint}`;
	return identity.packageName ?? identity.resolvedPath;
}

function describeAlternatives(items: readonly { identity: PortableExtensionIdentity }[]): string {
	const preferred = items.map((item) => describeQualified(item.identity));
	const counts = new Map<string, number>();
	for (const value of preferred) counts.set(value, (counts.get(value) ?? 0) + 1);
	return preferred
		.map((value, index) =>
			(counts.get(value) ?? 0) > 1
				? `${value} (path: ${items[index]!.identity.resolvedPath})`
				: value,
		)
		.sort()
		.join(", ");
}

function resolveSelector<T extends { identity: PortableExtensionIdentity }>(
	selector: string,
	items: readonly T[],
): T {
	const trimmed = selector.trim();
	const matches = items.filter((item) => selectorForms(item.identity).includes(trimmed));
	if (matches.length === 1) return matches[0]!;
	const available = describeAlternatives(items) || "none";
	if (matches.length === 0) {
		throw new Error(
			`unknown extension selector ${JSON.stringify(trimmed)}; discovered extensions: ${available}`,
		);
	}
	const qualified = describeAlternatives(matches);
	throw new Error(
		`ambiguous extension selector ${JSON.stringify(trimmed)}; matches: ${qualified}. ` +
			"Use <package-or-source>#<package-relative-entrypoint>.",
	);
}

/**
 * Resolve include/exclude selectors over discovered candidates. Includes are
 * additive validation; exclusions run last and therefore win.
 */
export function selectExtensionCandidates<T extends { identity: PortableExtensionIdentity }>(
	items: readonly T[],
	include: readonly string[] = [],
	exclude: readonly string[] = [],
): T[] {
	for (const selector of include) resolveSelector(selector, items);
	const removed = new Set<T>();
	for (const selector of exclude) removed.add(resolveSelector(selector, items));
	return items.filter((item) => !removed.has(item));
}

function sourceInfoForCandidate(candidatePath: string, metadata: {
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}): SourceInfo {
	return { path: candidatePath, ...metadata };
}

function canonicalPathKey(value: string): string {
	let key = path.resolve(value);
	try {
		key = fs.realpathSync(key);
	} catch {
		/* Pi reports unresolved extension paths through its normal diagnostics */
	}
	return key;
}

function dedupeCandidates(candidates: ExtensionPolicyCandidate[]): ExtensionPolicyCandidate[] {
	const seen = new Set<string>();
	const out: ExtensionPolicyCandidate[] = [];
	for (const candidate of candidates) {
		const key = canonicalPathKey(candidate.path);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out;
}

export interface ExtensionPolicyCandidateSelection {
	/** All enabled inherited/additive candidates before policy is applied. */
	candidates: ExtensionPolicyCandidate[];
	/** Candidates that survive include validation and exclusion. */
	selected: ExtensionPolicyCandidate[];
}

export interface WorkerExtensionLoadingContext {
	intercomBridge?: { active: boolean };
	/** Extension identities named by the worker's ext: tool selectors. */
	requestedExtensionSelectors?: readonly string[];
}

/**
 * Apply the worker-only pi-intercom default without changing explicit selector
 * semantics. An explicit include lifts the default, while selected exclusions
 * remain authoritative because they were already applied by `selectExtensionCandidates`.
 */
export function selectWorkerExtensionCandidates(
	selection: ExtensionPolicyCandidateSelection,
	agent: Pick<AgentConfig, "extensionInclude">,
	context?: WorkerExtensionLoadingContext,
): ExtensionPolicyCandidate[] {
	if (context?.intercomBridge?.active === true) return selection.selected;
	const explicitlyIncludesIntercom = (agent.extensionInclude ?? []).some((selector) =>
		selection.candidates.some(
			(candidate) =>
				isPiIntercomExtensionIdentity(candidate.identity) &&
				portableExtensionIdentityMatchesSelector(candidate.identity, selector),
		),
	);
	if (explicitlyIncludesIntercom) return selection.selected;
	return selection.selected.filter((candidate) => !isPiIntercomExtensionIdentity(candidate.identity));
}

/** Keep a configured extension factory failure fail-closed for a requested ext: tool. */
function assertRequestedExtensionCandidatesLoaded(
	requestedSelectors: readonly string[] | undefined,
	candidates: readonly ExtensionPolicyCandidate[],
	loadedExtensions: readonly Extension[],
	policySelected: readonly ExtensionPolicyCandidate[] = candidates,
	selectedForLoad: readonly ExtensionPolicyCandidate[] = policySelected,
): void {
	if (!requestedSelectors || requestedSelectors.length === 0) return;
	const loadedPaths = new Set(loadedExtensions.map((extension) => canonicalPathKey(extension.resolvedPath)));
	for (const selector of requestedSelectors) {
		const candidateMatches = candidates.filter((candidate) =>
			portableExtensionIdentityMatchesSelector(candidate.identity, selector),
		);
		const policyMatches = policySelected.filter((candidate) =>
			portableExtensionIdentityMatchesSelector(candidate.identity, selector),
		);
		const selectedMatches = selectedForLoad.filter((candidate) =>
			portableExtensionIdentityMatchesSelector(candidate.identity, selector),
		);
		const excluded = candidateMatches.filter((candidate) => !policyMatches.includes(candidate));
		if (excluded.length > 0) {
			throw new Error(
				`Could not use extension provider ${JSON.stringify(selector)} for an ext: tool selector; ` +
				`the extension is excluded by worker extension policy: ${excluded.map((candidate) => candidate.path).join(", ")}.`,
			);
		}
		const missing = selectedMatches.filter((candidate) => !loadedPaths.has(canonicalPathKey(candidate.path)));
		if (missing.length === 0) continue;
		throw new Error(
			`Could not load extension provider ${JSON.stringify(selector)} for an ext: tool selector; ` +
			`configured extension candidate(s) did not register: ${missing.map((candidate) => candidate.path).join(", ")}.`,
		);
	}
}

/**
 * Discover extension entrypoint paths and apply portable selectors without
 * importing extension modules. This is the pre-factory gate used by worker
 * loading for the default pi-intercom rule and for explicit include/exclude
 * policy. The detailed form retains the pre-policy set for consumers
 * (intercom/orchestrate) that must distinguish an absent extension from one
 * deliberately removed by policy.
 */
export async function resolveExtensionPolicyCandidateSelection(
	agent: Pick<AgentConfig, "extensions" | "extensionInclude" | "extensionExclude">,
	options: Pick<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">,
): Promise<ExtensionPolicyCandidateSelection> {
	const settingsManager = options.settingsManager ?? SettingsManager.create(options.cwd, options.agentDir);
	await settingsManager.reload();
	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
	const [configured, additional] = await Promise.all([
		packageManager.resolve(),
		packageManager.resolveExtensionSources(agent.extensions ?? [], { temporary: true }),
	]);
	const configuredExtensions = configured.extensions.filter((resource) => resource.enabled);
	const additionalExtensions = additional.extensions.filter((resource) => resource.enabled);
	// Preserve Pi's extension load order (additional paths before configured
	// paths), while preferring configured package provenance when the same
	// physical entrypoint is also supplied additively. Otherwise an npm/git
	// selector could stop matching merely because the agent repeated its path.
	const configuredMetadataByPath = new Map(
		configuredExtensions.map((resource) => [canonicalPathKey(resource.path), resource.metadata]),
	);
	const resources = [...additionalExtensions, ...configuredExtensions];
	const candidates = dedupeCandidates(
		resources.map((resource) => {
			const metadata = configuredMetadataByPath.get(canonicalPathKey(resource.path)) ?? resource.metadata;
			const info = sourceInfoForCandidate(resource.path, metadata);
			return {
				path: resource.path,
				sourceInfo: info,
				identity: derivePortableExtensionIdentity(resource.path, info),
			};
		}),
	);
	const selected = selectExtensionCandidates(
		candidates,
		agent.extensionInclude ?? [],
		agent.extensionExclude ?? [],
	);
	return { candidates, selected };
}

/** Return only candidates that survive policy (the common worker-loader path). */
export async function resolveExtensionPolicyCandidates(
	agent: Pick<AgentConfig, "extensions" | "extensionInclude" | "extensionExclude">,
	options: Pick<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">,
): Promise<ExtensionPolicyCandidate[]> {
	return (await resolveExtensionPolicyCandidateSelection(agent, options)).selected;
}

const FAILED_WORKER_RUNTIME_MESSAGE =
	"This extension ctx is stale after worker loader preparation failed. Do not use a captured pi or command ctx from the failed attempt.";
const invalidatedWorkerRuntimes = new WeakSet<ExtensionRuntime>();

/** Invalidate a loader runtime at most once across nested preparation seams. */
export function invalidateFailedWorkerRuntime(loader: DefaultResourceLoader, onInvalidate?: () => void): void {
	invalidateWorkerRuntime(loader.getExtensions().runtime, onInvalidate);
}

/** Invalidate an observed runtime exactly once, including override runtimes. */
export function invalidateWorkerRuntime(runtime: ExtensionRuntime, onInvalidate?: () => void): void {
	if (invalidatedWorkerRuntimes.has(runtime)) return;
	// A session dispose may invalidate and then throw.  Do not blindly invoke
	// invalidate again in that case; only retry when the runtime still proves
	// itself active after the failed disposal. The callback represents the
	// acquired runtime's release, not each SDK retry, so report it once.
	let notified = false;
	const notify = (): void => {
		if (notified) return;
		notified = true;
		onInvalidate?.();
	};
	try {
		runtime.assertActive();
	} catch {
		invalidatedWorkerRuntimes.add(runtime);
		return;
	}
	try {
		notify();
		runtime.invalidate(FAILED_WORKER_RUNTIME_MESSAGE);
		invalidatedWorkerRuntimes.add(runtime);
	} catch (error) {
		try {
			runtime.assertActive();
		} catch {
			invalidatedWorkerRuntimes.add(runtime);
			throw error;
		}
		// The first call threw without making the runtime stale. Retry once as
		// the partial-attempt cleanup fallback, then remember the outcome.
		try {
			runtime.invalidate(FAILED_WORKER_RUNTIME_MESSAGE);
		} finally {
			invalidatedWorkerRuntimes.add(runtime);
		}
		throw error;
	}
}

/**
 * Build and reload the worker loader. Workers without explicit policy retain
 * Pi's original loader options unless discovered candidates include
 * pi-intercom, which receives the worker-only default exclusion. Explicit
 * policy and lifted pi-intercom paths resolve without imports, then load only
 * the selected paths under `noExtensions`, so excluded factories never execute
 * or register anything.
 */
export async function loadWorkerResourceLoader(
	agent: Pick<AgentConfig, "extensions" | "extensionInclude" | "extensionExclude">,
	options: DefaultResourceLoaderOptions,
	onInvalidate?: () => void,
	context?: WorkerExtensionLoadingContext,
): Promise<DefaultResourceLoader> {
	const hasPolicy = Boolean(agent.extensionInclude?.length || agent.extensionExclude?.length);
	const selection = await resolveExtensionPolicyCandidateSelection(agent, options);
	const hasPiIntercomCandidate = selection.candidates.some((candidate) =>
		isPiIntercomExtensionIdentity(candidate.identity),
	);
	if (!hasPolicy && !hasPiIntercomCandidate) {
		const loader = new DefaultResourceLoader(options);
		try {
			await loader.reload();
			assertRequestedExtensionCandidatesLoaded(
				context?.requestedExtensionSelectors,
				selection.candidates,
				loader.getExtensions().extensions,
			);
			applyExtensionPolicy(loader.getExtensions(), agent);
			return loader;
		} catch (error) {
			try { invalidateFailedWorkerRuntime(loader, onInvalidate); } catch { /* preserve reload/policy failure */ }
			throw error;
		}
	}

	const selected = selectWorkerExtensionCandidates(selection, agent, context);
	const selectedPathKeys = new Set(selected.map((candidate) => canonicalPathKey(candidate.path)));
	const upstreamOverride = options.extensionsOverride;
	let overrideError: unknown;
	const observedRuntimes = new Set<ExtensionRuntime>();
	const loader = new DefaultResourceLoader({
		...options,
		noExtensions: true,
		additionalExtensionPaths: selected.map((candidate) => candidate.path),
		// Pi invokes this inside reload. Never throw from the callback: capture
		// the failure, return an empty extension set (fail closed), then surface
		// the error after reload has unwound safely. Runtime identity is checked
		// explicitly because extension factories captured the base runtime before
		// this callback; returning another runtime would make those APIs stale.
		extensionsOverride: (base) => {
			observedRuntimes.add(base.runtime);
			try {
				const overridden = upstreamOverride ? upstreamOverride(base) : base;
				observedRuntimes.add(overridden.runtime);
				if (overridden.runtime !== base.runtime) {
					throw new Error("extensionsOverride must preserve the loader runtime identity");
				}
				return {
					...overridden,
					extensions: overridden.extensions.filter(
						(extension) =>
							extension.path.startsWith("<inline:") ||
							selectedPathKeys.has(canonicalPathKey(extension.resolvedPath)),
					),
				};
			} catch (error) {
				overrideError = error;
				return { ...base, extensions: [] };
			}
		},
	});
	try {
		await loader.reload();
		if (overrideError !== undefined) {
			// The override runs during reload and factories may already have
			// captured this runtime before the error is surfaced.
			for (const runtime of observedRuntimes) {
				try { invalidateWorkerRuntime(runtime, onInvalidate); } catch { /* preserve policy failure */ }
			}
			try { invalidateFailedWorkerRuntime(loader, onInvalidate); } catch { /* preserve policy failure */ }
			throw new Error(
				`extension policy override failed: ${overrideError instanceof Error ? overrideError.message : String(overrideError)}`,
				{ cause: overrideError },
			);
		}
		assertRequestedExtensionCandidatesLoaded(
			context?.requestedExtensionSelectors,
			selection.candidates,
			loader.getExtensions().extensions,
			selection.selected,
			selected,
		);
		const selectedByPath = new Map(
			selected.map((candidate) => [canonicalPathKey(candidate.path), candidate.identity]),
		);
		for (const extension of loader.getExtensions().extensions) {
			const identity = selectedByPath.get(canonicalPathKey(extension.resolvedPath));
			if (identity) assignIdentity(extension, identity);
			else identify(extension);
		}
		return loader;
	} catch (error) {
		try { invalidateFailedWorkerRuntime(loader, onInvalidate); } catch { /* preserve reload/policy failure */ }
		throw error;
	}
}

/** Annotate loaded extensions and remove excluded registrations as whole units. */
export function applyExtensionPolicy(
	base: LoadExtensionsResult,
	agent: Pick<AgentConfig, "extensionInclude" | "extensionExclude">,
): LoadExtensionsResult {
	const include = agent.extensionInclude ?? [];
	const exclude = agent.extensionExclude ?? [];
	// Preserve the legacy fast path exactly: no policy means no package.json
	// walks or Git subprocesses merely to annotate identities nobody consumes.
	if (include.length === 0 && exclude.length === 0) return base;
	const items = base.extensions.map((extension) => ({ extension, identity: identify(extension) }));
	const selected = selectExtensionCandidates(items, include, exclude).map((item) => item.extension);
	return { ...base, extensions: selected };
}
