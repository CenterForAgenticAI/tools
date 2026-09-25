import type { AgentConfig } from "./agents.js";

/**
 * Return an actionable preflight error when a delegate invocation selects
 * repo-controlled agents but Pi has not trusted the current project.
 *
 * Pi owns project trust. The extension must not maintain a second trust store
 * or expose a model-controlled bypass.
 */
export function projectAgentTrustError(
	agents: readonly AgentConfig[],
	projectTrusted: boolean,
): string | undefined {
	const projectAgentNames = [
		...new Set(
			agents
				.filter((agent) => agent.source === "project")
				.map((agent) => agent.name),
		),
	];
	if (projectAgentNames.length === 0 || projectTrusted) return undefined;
	return (
		`Refusing to run project-local agent(s) ${projectAgentNames.join(", ")} because this ` +
		"project is not trusted by Pi. Trust the project in Pi and retry, or select only " +
		"builtin, package, or user agents."
	);
}
