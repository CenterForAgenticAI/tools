import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * CLI flag that switches extension-authoring guidance on.
 *
 * Namespaced on purpose. Registered flags share one global namespace across
 * every loaded extension, and Pi reports collisions while resolving precedence
 * by extension load order, so a generic `dev-mode` would be a poor neighbour.
 * `pi-context-aware` sets the same precedent with its `context-aware-*` flags.
 */
export const PI_DEV_MODE_FLAG = "pi-dev-mode";

/** The primary skill name used in the authoring pointer and diagnostics. */
export const AUTHORING_SKILL_NAME = "authoring-pi-extensions";

/**
 * The `@earendil-works/pi-coding-agent` minor series the shipped guidance was
 * last read against.
 *
 * Pinned to the minor series rather than the exact patch deliberately. The
 * dependency is declared as `^0.85.1`, which admits patch releases only, so an
 * exact pin would fail on patch bumps that cannot change the documented API.
 * A test that cries wolf teaches people to bump the constant without reading,
 * which is the opposite of the point. This fires when the series moves, which
 * is the deliberate act worth interrupting.
 */
export const GUIDANCE_VERIFIED_AGAINST = "0.85";

/** `1.2.3` -> `1.2`. Anything unparseable is returned unchanged. */
export function minorSeries(version: string): string {
  const parts = version.split(".");
  if (parts.length < 2) return version;
  return `${parts[0]}.${parts[1]}`;
}

/**
 * Whether dev mode is active for this session.
 *
 * Reading a flag must never be able to break a session, so an unavailable or
 * misbehaving flag API is treated as "off" — the safe direction for a feature
 * whose entire contract is that it is off unless asked for.
 */
export function isDevModeActive(pi: Pick<ExtensionAPI, "getFlag">): boolean {
  try {
    return pi.getFlag(PI_DEV_MODE_FLAG) === true;
  } catch {
    return false;
  }
}

/** Directory handed to Pi as a skill root; it is recursed for `SKILL.md`. */
export function authoringSkillRoot(): string {
  return fileURLToPath(new URL("../skills", import.meta.url));
}

const POINTER = `# Pi extension authoring

_Injected by the **@caair/pi-dev** extension because this session was started with \`--${PI_DEV_MODE_FLAG}\`. It is absent from every session that did not ask for it._

Before writing or changing Pi extension code, read the \`${AUTHORING_SKILL_NAME}\` skill. It covers which lifecycle events exist and what each handler may return, how \`before_agent_start\` chains the system prompt across extensions, how \`resources_discover\` contributes skills and prompts, the glob-expanded \`pi.extensions\` / \`pi.skills\` / \`pi.prompts\` discovery fields, and which public APIs are current rather than the deprecated \`@mariozechner/*\` surface.

For extension tests that exercise \`ctx.ui\`, \`pi.events\`, or \`pi.on\` handlers, import \`{ conformanceContext } from "@caair/pi-dev/testing"\` instead of using a handwritten double.

Runtime behavior is pinned: RPC mode can report \`hasUI=true\`; it stores string-array widgets, but silently ignores widget factories without invoking or storing them. Use \`ctx.mode\` to distinguish this behavior.

Clearing is pinned too: an empty status string remains stored, while only \`undefined\` clears keyed status or widget state.

Dispose registrations created on \`session_start\` during \`session_shutdown\` and before rebind. Prove with repeated-start tests that no registration leaks.

Do not reconstruct the extension contract from memory. The skill is written against the \`@earendil-works/pi-coding-agent\` version this package depends on; your recollection is not.`;

/** The guidance text itself, without any host prompt. Exported for tests. */
export function devModeGuidance(): string {
  return POINTER;
}

/**
 * The system prompt for a turn, or `undefined` to contribute nothing.
 *
 * Returning `undefined` matters: `systemPrompt` *replaces* the prompt for the
 * turn, so a handler that returned a bare pointer would discard whatever other
 * extensions had already contributed. This appends to what it was given, which
 * is what keeps the chain intact.
 */
export function devModeSystemPrompt(
  pi: Pick<ExtensionAPI, "getFlag">,
  incoming: string | undefined,
): string | undefined {
  if (!isDevModeActive(pi)) return undefined;
  if (incoming?.includes(POINTER)) return incoming;
  return `${incoming ?? ""}\n\n${POINTER}`;
}

/** The skill root for this session: one while active, none otherwise. */
export function devModeSkillPaths(pi: Pick<ExtensionAPI, "getFlag">): string[] {
  return isDevModeActive(pi) ? [authoringSkillRoot()] : [];
}
