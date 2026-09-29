import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ResolveSocketPathOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

export function resolveSocketPath(options: ResolveSocketPathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const configured = environment.PI_DAEMON_SOCKET;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new TypeError("PI_DAEMON_SOCKET must be an absolute path");
    }
    return configured;
  }

  if (environment.XDG_RUNTIME_DIR !== undefined) {
    return resolve(environment.XDG_RUNTIME_DIR, "pi-daemon", "pi-daemon.sock");
  }

  const home = options.homeDirectory ?? environment.HOME ?? homedir();
  return resolve(home, ".local", "state", "pi-daemon", "run", "pi-daemon.sock");
}

export async function prepareSocketEndpoint(socketPath: string): Promise<void> {
  if (!isAbsolute(socketPath)) throw new TypeError("socketPath must be an absolute path");
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await verifyOwnedDirectory(parent);
  await chmod(parent, 0o700);
  await verifyModeAndOwner(parent, 0o700, "socket parent directory");

  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }

  if (!existing.isSocket()) {
    throw new Error(`refusing to replace existing non-socket path: ${socketPath}`);
  }
  verifyOwner(existing.uid, "existing socket");

  if (await connectionProbeSucceeds(socketPath)) {
    throw new Error(`a daemon is already listening at ${socketPath}`);
  }

  const current = await lstat(socketPath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (current === undefined) return;
  if (!current.isSocket() || current.dev !== existing.dev || current.ino !== existing.ino) {
    throw new Error(`socket path changed during stale-socket probe: ${socketPath}`);
  }
  verifyOwner(current.uid, "stale socket");
  await unlink(socketPath);
}

export async function secureBoundSocket(socketPath: string): Promise<void> {
  await chmod(socketPath, 0o600);
  const socket = await lstat(socketPath);
  if (!socket.isSocket()) {
    throw new Error(`bound socket path is not a socket: ${socketPath}`);
  }
  verifyOwner(socket.uid, "socket");
  if ((socket.mode & 0o777) !== 0o600) {
    throw new Error(`socket at ${socketPath} is not mode 0600`);
  }
  await verifyModeAndOwner(dirname(socketPath), 0o700, "socket parent directory");
}

async function verifyOwnedDirectory(path: string): Promise<void> {
  const current = await lstat(path);
  if (!current.isDirectory()) throw new Error(`socket parent is not a directory: ${path}`);
  verifyOwner(current.uid, "socket parent directory");
}

async function verifyModeAndOwner(
  path: string,
  expectedMode: number,
  label: string,
): Promise<void> {
  const current = await lstat(path);
  verifyOwner(current.uid, label);
  const mode = current.mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(
      `${label} at ${path} has mode ${mode.toString(8)}; expected ${expectedMode.toString(8)}`,
    );
  }
}

function verifyOwner(uid: number, label: string): void {
  const getEffectiveUid = process.geteuid;
  if (getEffectiveUid === undefined) {
    throw new Error("Unix socket ownership checks require process.geteuid()");
  }
  const effectiveUid = getEffectiveUid();
  if (uid !== effectiveUid) {
    throw new Error(`${label} is owned by uid ${uid}; expected effective uid ${effectiveUid}`);
  }
}

const STALE_SOCKET_PROBE_TIMEOUT_MS = 250;

async function connectionProbeSucceeds(socketPath: string): Promise<boolean> {
  return await new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      rejectProbe(new Error(`timed out probing existing socket; refusing removal: ${socketPath}`));
    }, STALE_SOCKET_PROBE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners("connect");
      socket.removeAllListeners("error");
    };
    socket.once("connect", () => {
      cleanup();
      socket.destroy();
      resolveProbe(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolveProbe(false);
        return;
      }
      rejectProbe(error);
    });
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
