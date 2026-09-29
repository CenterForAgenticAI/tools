#!/usr/bin/env node

const { DaemonAlreadyRunningError, runDaemon } = await import("../dist/daemon/bootstrap.js");

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
