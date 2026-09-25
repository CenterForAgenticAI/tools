import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function workStatusCommand(pi: ExtensionAPI): CommandOptions {
	return {
		description: "Derive pi-work status with work_status.",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			const request = "Use the work_status tool to derive status from the explicitly identified pi-work spec and tree. Do not request refresh; return the observed result and stop after this round.";
			pi.sendUserMessage(args.trim() ? `${request}\n\nUser arguments: ${args.trim()}` : request);
		},
	};
}
