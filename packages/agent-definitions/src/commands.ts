import type { Command } from "./cli.ts";
import { convertCommand } from "./convert-command.ts";
import { lintCommand } from "./lint-command.ts";

/** The subcommands of the `agent-definitions` command. */
export const commands: Readonly<Record<string, Command>> = {
	convert: convertCommand,
	lint: lintCommand,
};
