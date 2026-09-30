import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DoctorCheck, DoctorDependencies } from "./dev-types.ts";
import { PI_DEV_VERSION } from "./dev-types.ts";
import { AUTHORING_SKILL_NAME, isDevModeActive, PI_DEV_MODE_FLAG } from "./dev-mode.ts";

function hasFunctions(object: object, names: readonly string[]): boolean {
  const record = object as Record<string, unknown>;
  return names.every((name) => typeof record[name] === "function");
}

function callString(object: object, name: string): string | undefined {
  const candidate = (object as Record<string, unknown>)[name];
  if (typeof candidate !== "function") return undefined;
  try {
    const result: unknown = candidate.call(object);
    return typeof result === "string" && result.length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function safeExists(dependencies: DoctorDependencies, candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    return dependencies.pathExists(candidate);
  } catch {
    return false;
  }
}

export async function runDoctor(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  dependencies: DoctorDependencies,
): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "Package versions",
    status: "pass",
    detail: `Pi ${dependencies.piVersion}; pi-dev ${PI_DEV_VERSION}`,
  });

  const devMode = isDevModeActive(pi);
  checks.push({
    name: "Extension-authoring mode",
    status: "pass",
    detail: devMode
      ? `Active via --${PI_DEV_MODE_FLAG}: authoring guidance is injected and the ${AUTHORING_SKILL_NAME} skill is contributed.`
      : `Off. Start Pi with --${PI_DEV_MODE_FLAG} to contribute authoring guidance and the ${AUTHORING_SKILL_NAME} skill.`,
  });

  const runtimeOkay = hasFunctions(pi, ["getActiveTools", "getAllTools", "getCommands"])
    && hasFunctions(ctx, ["getSystemPrompt", "getContextUsage"])
    && hasFunctions(ctx.sessionManager, ["getSessionFile", "getSessionId", "getSessionDir", "buildContextEntries"]);
  checks.push({
    name: "Pi runtime APIs",
    status: runtimeOkay ? "pass" : "fail",
    detail: runtimeOkay
      ? "Public tool, prompt, context, and SessionManager APIs are available."
      : "One or more required public extension APIs are unavailable.",
  });

  const sessionFile = callString(ctx.sessionManager, "getSessionFile");
  const sessionAvailable = path.isAbsolute(sessionFile ?? "") && safeExists(dependencies, sessionFile);
  checks.push({
    name: "Current session",
    status: sessionAvailable ? "pass" : "fail",
    detail: !sessionFile
      ? "Current session path API is unavailable, or the session is in-memory/not persisted."
      : sessionAvailable
        ? `Persisted session file is available: ${sessionFile}`
        : `Session file is unavailable: ${sessionFile}`,
  });

  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const symbol = (status: DoctorCheck["status"]): string => status === "pass" ? "PASS" : status === "warn" ? "WARN" : "FAIL";
  return [
    "pi-dev doctor (metadata only; no session or prompt content is read)",
    "",
    ...checks.map((check) => `[${symbol(check.status)}] ${check.name}: ${check.detail}`),
  ].join("\n");
}
