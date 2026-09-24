#!/usr/bin/env node
import { runDaemon } from "../src/daemon.ts";
import { defaultEndpoint, ensureDaemon, getDaemonHealth, readServerInfo } from "../src/daemon-control.ts";
import type { ExternalCallbackPayload } from "../src/types.ts";

const argv = process.argv.slice(2);
const command = argv[0];

function value(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function has(flag: string): boolean {
  return argv.includes(flag);
}

function usage(code = 0): never {
  const text = `pi-callbacks — central callback daemon and token callback CLI

Usage:
  pi-callbacks callback --token <token> [--endpoint <url>] [--message <text>] [--status success|failure|info] [--details-json <json>] [--no-complete]
  pi-callbacks callback --token <token> --message "tests passed"
  pi-callbacks endpoint
  pi-callbacks status
  pi-callbacks start
  pi-callbacks daemon

Environment:
  PI_CALLBACK_TOKEN     Used when --token is omitted.
  PI_CALLBACK_ENDPOINT  Override callback URL. Defaults to the central daemon endpoint.
`;
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

async function main(): Promise<void> {
  if (!command || command === "help" || command === "--help" || command === "-h") usage(0);
  if (command === "daemon") {
    runDaemon();
    return;
  }
  if (command === "start") {
    const status = await ensureDaemon(new URL(import.meta.url).pathname);
    if (status === "down") throw new Error("pi-callbacks daemon did not become reachable");
    console.log(defaultEndpoint());
    return;
  }
  if (command === "status") {
    const health = await getDaemonHealth();
    const info = readServerInfo();
    const status = health?.daemon !== "pi-callbacks" ? "down" : health.ok ? "running" : "degraded";
    console.log(JSON.stringify({ healthy: status === "running", status, endpoint: defaultEndpoint(), ...info, ...(health ?? {}) }, null, 2));
    return;
  }
  if (command === "endpoint") {
    console.log(endpoint());
    return;
  }
  if (command !== "callback") usage(1);

  const token = value("--token") || process.env.PI_CALLBACK_TOKEN;
  if (!token) throw new Error("Missing --token (or PI_CALLBACK_TOKEN)");

  let details: unknown = undefined;
  const detailsJson = value("--details-json");
  if (detailsJson) details = JSON.parse(detailsJson);

  const message = value("--message");
  const status = (value("--status") as ExternalCallbackPayload["status"]) || "success";
  const payload: ExternalCallbackPayload = {
    token,
    ...(message === undefined ? {} : { message }),
    status,
    ...(details === undefined ? {} : { details }),
    complete: !has("--no-complete"),
  };

  if (!value("--endpoint") && !process.env.PI_CALLBACK_ENDPOINT) {
    const status = await ensureDaemon(new URL(import.meta.url).pathname);
    if (status === "down") throw new Error("pi-callbacks daemon did not become reachable");
  }

  const response = await fetch(endpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Callback failed: HTTP ${response.status} ${body}`);
  console.log(body);
}

function endpoint(): string {
  const explicit = value("--endpoint") || process.env.PI_CALLBACK_ENDPOINT;
  if (explicit) return explicit;
  return defaultEndpoint();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
