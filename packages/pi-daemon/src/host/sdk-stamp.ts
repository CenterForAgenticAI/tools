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

export const STAMPED_HOST_SDK_VERSION = "0.99.2";

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
  if (installedVersion !== STAMPED_HOST_SDK_VERSION) {
    throw new SdkCompatibilityError(
      `sdk_incompatible: SDK ${installedVersion} has no passing host stamp`,
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
