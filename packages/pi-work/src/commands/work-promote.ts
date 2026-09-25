import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function workPromoteCommand(pi: ExtensionAPI): CommandOptions {
	return {
		description: "Promote one pi-work draft with work_promote.",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			const request = "Use the work_promote tool to promote the named pi-work draft into a workspec. Return the tool result and stop after this round.";
			pi.sendUserMessage(args.trim() ? `${request}\n\nUser arguments: ${args.trim()}` : request);
		},
	};
}
