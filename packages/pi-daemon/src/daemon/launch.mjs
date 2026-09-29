import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import "./source-hooks.mjs";

const moduleUrl = new URL(
  existsSync(fileURLToPath(new URL("./bootstrap.js", import.meta.url)))
    ? "./bootstrap.js"
    : "./bootstrap.ts",
  import.meta.url,
);
const { DaemonAlreadyRunningError, runDaemon } = await import(moduleUrl.href);

try {
  const daemon = await runDaemon();
  void daemon.finished.then((outcome) => {
    if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
    if (outcome.deadlineExceeded) process.exit(outcome.exitCode);
  });
  let closing;
  const close = () => {
    closing ??= daemon.close().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  if (!(error instanceof DaemonAlreadyRunningError)) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
