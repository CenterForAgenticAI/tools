import type { AgentFormat } from "../report.ts";
import { claudeCodeFormat } from "./claude-code.ts";
import { codexFormat } from "./codex.ts";
import { copilotFormat } from "./copilot.ts";
import { geminiCliFormat } from "./gemini-cli.ts";
import { opencodeFormat } from "./opencode.ts";
import { piAgentsFormat } from "./pi-agents.ts";

export const formats: readonly AgentFormat[] = [
	claudeCodeFormat,
	codexFormat,
	copilotFormat,
	geminiCliFormat,
	opencodeFormat,
	piAgentsFormat,
];

export function findFormat(name: string): AgentFormat | undefined {
	return formats.find((format) => format.name === name);
}
