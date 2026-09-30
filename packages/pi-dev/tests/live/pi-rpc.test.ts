import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AUTHORING_SKILL_NAME, devModeGuidance } from "../../src/dev-mode.ts";

type RpcMessage = Record<string, unknown>;
type RpcResponse = RpcMessage & { id: string; success: boolean };

type PendingResponse = {
  resolve: (message: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const piBinary = path.join(repoRoot, "node_modules/.bin/pi");

class RpcSession {
  readonly messages: RpcMessage[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingResponse>();
  private nextId = 0;
  private stdoutBuffer = "";
  private stderr = "";

  constructor(devMode: boolean, agentDir: string) {
    this.child = spawn(
      piBinary,
      [
        "--mode",
        "rpc",
        "--no-session",
        "--no-approve",
        "--offline",
        ...(devMode ? ["--pi-dev-mode"] : []),
        "-e",
        "./index.ts",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: path.dirname(agentDir),
          PI_CODING_AGENT_DIR: agentDir,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("close", (code, signal) => {
      this.failPending(new Error(`Pi RPC exited before responding (code=${code}, signal=${signal}). stderr=${this.stderr}`));
    });
  }

  async send(type: string, fields: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = `test_${++this.nextId}`;
    const message = JSON.stringify({ id, type, ...fields });
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${type}. stderr=${this.stderr}`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${message}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async close(): Promise<void> {
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 1_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      this.messages.push(message);
      if (typeof message.id !== "string") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message as RpcResponse);
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

async function runLiveInspection(devMode: boolean): Promise<{ prompt: string; commands: string[] }> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "pi-dev-live-"));
  const agentDir = path.join(tempRoot, "agent");
  const session = new RpcSession(devMode, agentDir);
  try {
    // This is deliberately the first command: no agent turn has run yet.
    const promptResponse = await session.send("prompt", { message: "/dev prompt" });
    assert.equal(promptResponse.success, true, JSON.stringify(promptResponse));
    const promptMessage = session.messages.find(
      (message) => message.type === "extension_ui_request"
        && message.method === "notify"
        && typeof message.message === "string"
        && message.message.startsWith("Effective system prompt\n"),
    );
    assert.ok(promptMessage, `missing /dev prompt notification; messages=${JSON.stringify(session.messages)}`);
    const fullPrompt = promptMessage.message as string;
    const prompt = fullPrompt.slice("Effective system prompt\n".length);

    const commandsResponse = await session.send("get_commands");
    assert.equal(commandsResponse.success, true, JSON.stringify(commandsResponse));
    const data = commandsResponse.data as { commands?: Array<{ name?: unknown }> };
    const commands = (data.commands ?? []).flatMap((command) => typeof command.name === "string" ? [command.name] : []);
    return { prompt, commands };
  } finally {
    await session.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("installed Pi RPC shows the effective authoring prompt and skill", { timeout: 20_000 }, async () => {
  const off = await runLiveInspection(false);
  assert.equal(off.prompt.includes(devModeGuidance()), false);
  assert.equal(off.commands.includes(`skill:${AUTHORING_SKILL_NAME}`), false);

  const on = await runLiveInspection(true);
  assert.equal(on.prompt.includes(devModeGuidance()), true);
  assert.equal(on.prompt.split(devModeGuidance()).length - 1, 1, "guidance must appear once");
  assert.ok(on.commands.includes(`skill:${AUTHORING_SKILL_NAME}`));

});
