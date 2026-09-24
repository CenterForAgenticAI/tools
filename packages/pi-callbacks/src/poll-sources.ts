import { spawn, spawnSync } from "node:child_process";
import type { GitLabPipelineSource, PollResult, PollSource } from "./types.ts";
import { truncateMiddle } from "./utils.ts";

export interface PollSourceExecutionHooks {
  onSpawn: (pid: number) => void;
  onGroupExit: (pid: number) => void;
}

export interface PollSourceAdapter<S extends PollSource = PollSource> {
  kind: S["kind"];
  preflight: (source: S) => void;
  execute: (source: S, timeoutMs: number, hooks?: PollSourceExecutionHooks) => Promise<PollResult>;
}

const GITLAB_PIPELINE_TERMINAL_STATUS = /^(success|failed|canceled|skipped|manual)$/;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const SOURCE_DIAGNOSTIC_MAX_LENGTH = 8_000;

function glabChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GITLAB_TOKEN;
  return environment;
}

function sanitizeSourceDiagnostic(value: string): string {
  const sanitized = value
    .replace(/\b(?:authorization\s*[:=]\s*)?bearer\s+[^\s"'`,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:gitlab[_ -]?token|private[_ -]?token|access[_ -]?token|token)\b\s*[:=]\s*["']?[^\s"'`,;&]+/gi, (match) => `${match.slice(0, match.search(/[:=]/))}=[redacted]`)
    .replace(/([?&](?:private[_-]?token|access[_-]?token|token)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\bglpat-[a-z0-9_-]+\b/gi, "glpat-[redacted]");
  return truncateMiddle(sanitized, SOURCE_DIAGNOSTIC_MAX_LENGTH);
}

export function projectPollSource(source: PollSource): PollSource {
  return {
    kind: source.kind,
    host: source.host,
    project: source.project,
    pipelineId: source.pipelineId,
  };
}

export function gitLabPipelineApiArgs(source: GitLabPipelineSource): string[] {
  return [
    "api",
    "--hostname",
    source.host,
    `projects/${encodeURIComponent(source.project)}/pipelines/${source.pipelineId}`,
  ];
}

function parsePipelineResponse(stdout: string): { status: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`unparseable GitLab pipeline response: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { status?: unknown }).status !== "string" || (parsed as { status: string }).status.length === 0) {
    throw new Error("unparseable GitLab pipeline response: expected a status string");
  }
  return { status: (parsed as { status: string }).status };
}

function processFailure(stderr: string, stdout: string, error?: Error): string {
  return sanitizeSourceDiagnostic(stderr.trim() || stdout.trim() || error?.message || "glab exited without a response");
}

function runGlabPreflight(source: GitLabPipelineSource): void {
  const result = spawnSync("glab", gitLabPipelineApiArgs(source), {
    encoding: "utf8",
    timeout: PREFLIGHT_TIMEOUT_MS,
    env: glabChildEnvironment(),
  });
  const spawnError = result.error instanceof Error ? result.error : undefined;
  if (spawnError || result.status !== 0) {
    const message = processFailure(result.stderr ?? "", result.stdout ?? "", spawnError);
    throw new Error(message, { cause: spawnError });
  }
  try {
    parsePipelineResponse(result.stdout ?? "");
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error), { cause: error });
  }
}

function executeGlab(source: GitLabPipelineSource, timeoutMs: number, hooks?: PollSourceExecutionHooks): Promise<PollResult> {
  const at = Date.now();
  return new Promise((resolve) => {
    const child = spawn("glab", gitLabPipelineApiArgs(source), { detached: true, env: glabChildEnvironment() });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let groupReleased = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    const childPid = child.pid;
    const releaseGroup = (): void => {
      if (groupReleased) return;
      groupReleased = true;
      if (childPid !== undefined) hooks?.onGroupExit(childPid);
    };
    if (childPid !== undefined) hooks?.onSpawn(childPid);
    const terminate = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the timeout and the kill.
      }
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process group may already have exited after killing the child.
        }
      }
    };
    const clearEscalation = (): void => {
      if (escalationTimer) clearTimeout(escalationTimer);
      escalationTimer = undefined;
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      terminate("SIGTERM");
      escalationTimer = setTimeout(() => {
        terminate("SIGKILL");
        escalationTimer = undefined;
        releaseGroup();
      }, 250);
      resolve({
        at,
        ok: false,
        stdout: sanitizeSourceDiagnostic(stdout),
        stderr: sanitizeSourceDiagnostic(stderr),
        error: sanitizeSourceDiagnostic(`Poll timed out after ${timeoutMs}ms`),
        matched: false,
      });
    }, timeoutMs);
    const finish = (result: PollResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearEscalation();
      releaseGroup();
      resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); stdout = stdout.slice(-20_000); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); stderr = stderr.slice(-20_000); });
    child.on("error", (error) => {
      finish({ at, ok: false, stdout: sanitizeSourceDiagnostic(stdout), stderr: sanitizeSourceDiagnostic(stderr), error: sanitizeSourceDiagnostic(error.message), matched: false });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          at,
          ok: false,
          ...(code === null ? {} : { exitCode: code }),
          stdout: sanitizeSourceDiagnostic(stdout),
          stderr: sanitizeSourceDiagnostic(stderr),
          error: processFailure(stderr, stdout),
          matched: false,
        });
        return;
      }
      try {
        const { status } = parsePipelineResponse(stdout);
        finish({
          at,
          ok: status === "success",
          status,
          text: status,
          stdout: sanitizeSourceDiagnostic(stdout),
          stderr: sanitizeSourceDiagnostic(stderr),
          matched: false,
        });
      } catch (error) {
        finish({
          at,
          ok: false,
          stdout: sanitizeSourceDiagnostic(stdout),
          stderr: sanitizeSourceDiagnostic(stderr),
          error: sanitizeSourceDiagnostic(error instanceof Error ? error.message : String(error)),
          matched: false,
        });
      }
    });
  });
}

const gitLabPipelineAdapter: PollSourceAdapter<GitLabPipelineSource> = {
  kind: "gitlab_pipeline",
  preflight: runGlabPreflight,
  execute: executeGlab,
};

const pollSourceAdapters: { [K in PollSource["kind"]]: PollSourceAdapter<Extract<PollSource, { kind: K }>> } = {
  gitlab_pipeline: gitLabPipelineAdapter,
};

export function preflightPollSource(source: PollSource): void {
  const adapter = pollSourceAdapters[source.kind] as PollSourceAdapter<typeof source>;
  adapter.preflight(source);
}

export function executePollSource(source: PollSource, timeoutMs: number, hooks?: PollSourceExecutionHooks): Promise<PollResult> {
  const adapter = pollSourceAdapters[source.kind] as PollSourceAdapter<typeof source>;
  return adapter.execute(source, timeoutMs, hooks);
}

export function isTerminalPollSourceStatus(status: string): boolean {
  return GITLAB_PIPELINE_TERMINAL_STATUS.test(status);
}
