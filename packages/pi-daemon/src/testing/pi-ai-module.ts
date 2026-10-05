import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path of a file inside a package that the installed Pi SDK depends on.
 *
 * pi-daemon does not depend on these packages directly, so it cannot import
 * them by name. Older SDK releases installed them nested under the SDK package;
 * current releases let npm hoist them beside the SDK. Prefer the nested copy so
 * the daemon always loads the same instance as the SDK.
 *
 * @param packageFile path below `node_modules`, for example
 *   `@earendil-works/pi-ai/dist/index.js`.
 */
export function resolveSdkDependencyPath(packageFile: string): string {
  const sdkPackageRoot = dirname(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  );
  const nodeModules = dirname(dirname(sdkPackageRoot));
  const candidates = [
    join(sdkPackageRoot, "node_modules", packageFile),
    join(nodeModules, packageFile),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`cannot locate ${packageFile} for the Pi SDK at ${sdkPackageRoot}`);
  }
  return found;
}

/** Absolute path of the `@earendil-works/pi-ai` entry that the installed Pi SDK uses. */
export function resolvePiAiModulePath(): string {
  return resolveSdkDependencyPath("@earendil-works/pi-ai/dist/index.js");
}
