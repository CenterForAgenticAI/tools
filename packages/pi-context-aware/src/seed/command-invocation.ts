/**
 * `/compact-then /<command> <args>` runs the command after compaction. This
 * module only recognises the invocation and splits it; Pi dispatches it.
 * The text after the name is never rewritten, so arguments reach the command
 * exactly as typed.
 */
export interface CommandInvocation {
	readonly name: string;
	readonly argsText: string;
}

// A command name starts with a letter or digit and holds no "/". Text such as
// "/tmp/build is broken" is a path in a free-text seed, not a command.
const COMMAND_INVOCATION = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/u;

export function parseCommandInvocation(seed: string): CommandInvocation | null {
	const match = COMMAND_INVOCATION.exec(seed);
	if (!match?.[1]) return null;
	return { name: match[1], argsText: match[2] ?? "" };
}
