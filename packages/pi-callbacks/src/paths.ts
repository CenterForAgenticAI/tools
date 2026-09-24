import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47837;

export function callbacksDir(): string {
  const configuredCallbacksDir = process.env.PI_CALLBACKS_DIR;
  return configuredCallbacksDir
    ? path.resolve(configuredCallbacksDir)
    : path.join(os.homedir(), ".pi", "agent", "callbacks");
}

export function storeFile(): string {
  return path.join(callbacksDir(), "jobs.json");
}

export function serverFile(): string {
  return path.join(callbacksDir(), "server.json");
}

export function configFile(): string {
  return path.join(callbacksDir(), "config.json");
}

export const CALLBACKS_DIR = callbacksDir();
export const STORE_FILE = storeFile();
export const SERVER_FILE = serverFile();
export const CONFIG_FILE = configFile();
