import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function workDraftCommand(pi: ExtensionAPI): CommandOptions {
	return {
		description: "Start one pi-work authoring round.",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			const request = "Use the work-authoring skill to draft a pi-work workspec. Do not promote, plan, verify, or dispatch until this authoring round is complete.";
			pi.sendUserMessage(args.trim() ? `${request}\n\nUser arguments: ${args.trim()}` : request);
		},
	};
}
