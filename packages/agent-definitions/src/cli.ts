/** What a command line subcommand may use from its process. Tests pass their own. */
export interface CommandIO {
	readonly cwd: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

/** One command line subcommand. Resolves to the process exit status. */
export type Command = (args: readonly string[], io: CommandIO) => Promise<number>;

/** Exit status for a usage mistake, such as a missing or unknown command. */
export const USAGE_EXIT = 2;

/** Run the subcommand named by the first argument. */
export async function runCli(
	args: readonly string[],
	io: CommandIO,
	commands: Readonly<Record<string, Command>>,
): Promise<number> {
	const usage = `Usage: agent-definitions <command> [options]\nCommands: ${Object.keys(commands).sort().join(", ")}\n`;
	const [name, ...rest] = args;
	if (name === undefined) {
		io.stderr(usage);
		return USAGE_EXIT;
	}
	if (name === "help" || name === "--help" || name === "-h") {
		io.stdout(usage);
		return 0;
	}
	const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
	if (command === undefined) {
		io.stderr(`Unknown command "${name}".\n${usage}`);
		return USAGE_EXIT;
	}
	return command(rest, io);
}
