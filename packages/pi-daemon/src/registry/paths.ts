import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";

export interface DaemonPaths {
  readonly stateDir: string;
  readonly lockPath: string;
  readonly registryPath: string;
}

export interface ResolveDaemonPathsOptions {
  readonly stateDir?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function canonicalizeSessionFilePath(sessionFile: string): string {
  if (!isAbsolute(sessionFile)) {
    throw new TypeError("sessionFile must be an absolute path");
  }

  try {
    return realpathSync(sessionFile);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  return resolve(realpathSync(dirname(sessionFile)), basename(sessionFile));
}

export function resolveDaemonPaths(
  options: ResolveDaemonPathsOptions = {},
): DaemonPaths {
  const environment = options.environment ?? process.env;
  const stateDir = resolve(
    options.stateDir ??
      environment.PI_DAEMON_STATE_DIR ??
      resolve(environment.XDG_STATE_HOME ?? environment.HOME ?? homedir(), "pi-daemon"),
  );

  return {
    stateDir,
    lockPath: resolve(stateDir, "daemon.lock"),
    registryPath: resolve(stateDir, "registry.sqlite3"),
  };
}
