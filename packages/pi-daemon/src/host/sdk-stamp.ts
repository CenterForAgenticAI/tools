import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { HostSdkCompatibility } from "./session-host.js";

/**
 * Oldest Pi SDK whose in-process host seams this daemon has verified. Newer
 * releases are accepted when the capability probe passes; older ones are
 * refused before any session is hosted (I29).
 */
export const MINIMUM_HOST_SDK_VERSION = "1.0.0";

export class SdkCompatibilityError extends Error {
  readonly code = "sdk_incompatible";

  constructor(message: string) {
    super(message);
    this.name = "SdkCompatibilityError";
  }
}

function installedSdkVersion(): string {
  const sdkRoot = dirname(
    dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
  );
  const packageJson = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("installed SDK package has no string version");
  }
  return packageJson.version;
}

/**
 * Version of the Pi SDK installed beside this daemon, as reported in hello.
 * An unreadable install reports "unknown", which the startup check refuses.
 */
export const HOST_SDK_VERSION: string = (() => {
  try {
    return installedSdkVersion();
  } catch {
    return "unknown";
  }
})();

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * True when `version` is a release at or above MINIMUM_HOST_SDK_VERSION. A
 * prerelease of the minimum itself is below it; unparseable versions fail.
 */
export function isSupportedSdkVersion(version: string): boolean {
  const candidate = RELEASE_VERSION.exec(version.trim());
  const minimum = RELEASE_VERSION.exec(MINIMUM_HOST_SDK_VERSION);
  if (candidate === null || minimum === null) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(candidate[index]) - Number(minimum[index]);
    if (difference !== 0) return difference > 0;
  }
  return candidate[4] === undefined;
}

function probeSdkSurface(): void {
  if (
    typeof createAgentSession !== "function" ||
    typeof SessionManager.create !== "function" ||
    typeof SessionManager.open !== "function" ||
    typeof SessionManager.prototype._persist !== "function" ||
    typeof SessionManager.prototype.appendCustomEntry !== "function" ||
    typeof DefaultResourceLoader.prototype.reload !== "function" ||
    typeof AgentSession.prototype.clearQueue !== "function"
  ) {
    throw new Error("required in-process host seam is unavailable");
  }
}

export const defaultHostSdkCompatibility: HostSdkCompatibility = {
  installedVersion: installedSdkVersion,
  probe: probeSdkSurface,
};

export async function assertSdkCompatible(
  compatibility: HostSdkCompatibility = defaultHostSdkCompatibility,
): Promise<string> {
  let installedVersion: string;
  try {
    installedVersion = compatibility.installedVersion();
  } catch (error) {
    throw new SdkCompatibilityError(
      `sdk_incompatible: cannot read installed SDK version: ${errorMessage(error)}`,
    );
  }
  if (!isSupportedSdkVersion(installedVersion)) {
    throw new SdkCompatibilityError(
      `sdk_incompatible: SDK ${installedVersion} is below the minimum supported ${MINIMUM_HOST_SDK_VERSION}`,
    );
  }
  try {
    await compatibility.probe();
  } catch (error) {
    throw new SdkCompatibilityError(
      `sdk_incompatible: SDK compatibility probe failed: ${errorMessage(error)}`,
    );
  }
  return installedVersion;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
