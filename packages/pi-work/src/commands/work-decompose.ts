import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function workDecomposeCommand(pi: ExtensionAPI): CommandOptions {
	return {
		description: "Start one pi-work decomposition round.",
		handler: async (args: string, _ctx: ExtensionCommandContext) => {
			const request = "Use the work-decomposition skill to run one decomposition round for the explicitly identified pi-work draft or spec: carve the work graph, assign criterion homes, scope touches, record open decisions, and validate the result as appropriate. Do not plan or dispatch work, and do not loop, wait, sequence, retry, or poll; return control after this round.";
			pi.sendUserMessage(args.trim() ? `${request}\n\nUser arguments: ${args.trim()}` : request);
		},
	};
}
