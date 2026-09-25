import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function workNextCommand(pi: ExtensionAPI): CommandOptions {
	return {
		description: "Compile and hand off exactly one pi-work round.",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			const request = "Use work_plan to compile and hand off exactly one ready pi-work round through the available delegate tool. Do not loop, wait, sequence, retry, or poll; return control after that one handoff.";
			pi.sendUserMessage(args.trim() ? `${request}\n\nUser arguments: ${args.trim()}` : request);
		},
	};
}
