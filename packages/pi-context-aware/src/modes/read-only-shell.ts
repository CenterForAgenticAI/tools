/**
 * A narrow allow-list for `bash` commands a mode treats as read-only.
 *
 * It is not a sandbox. It accepts one simple command with no shell syntax,
 * from a short list of programs, each with a short list of options. Any other
 * argument that starts with `-` is refused, so an option nobody reviewed cannot
 * write a file or run another program. It cannot see configuration the programs
 * read, such as a git pager, external diff, textconv driver, fsmonitor hook or
 * `log.showSignature`, or an rg config file.
 */

const MAX_COMMAND_LENGTH = 1_000;

/**
 * Printable ASCII letters, digits, space, tab and `% + , - . / : = @ ^ _`.
 * Every shell metacharacter, quote, control character and non-ASCII character
 * is outside it.
 */
const ALLOWED_CHARACTERS = /^[A-Za-z0-9 \t%+,\-./:=@^_]*$/;

type ValueCheck = (value: string) => boolean;

/** A count: digits only. */
const COUNT: ValueCheck = (value) => /^[0-9]+$/.test(value);
/** A pattern, path, range or name that does not look like an option. */
const WORD: ValueCheck = (value) => value.length > 0 && !value.startsWith("-");
/** An fd file type: file, directory or symlink. */
const FD_TYPE: ValueCheck = (value) => value === "f" || value === "d" || value === "l";

interface OptionSpec {
	/** Options that take no value, matched exactly. */
	readonly flags?: readonly string[];
	/** Short options that take a value, attached (`-n5`) or as the next word (`-n 5`). */
	readonly valued?: ReadonlyMap<string, ValueCheck>;
	/** Short options whose value must be attached (`-U3`), because the program reads a next word as a path. */
	readonly attached?: ReadonlyMap<string, ValueCheck>;
	/** Long options that take a value after `=` only (`--max-count=5`). */
	readonly longValued?: ReadonlyMap<string, ValueCheck>;
	/** Letters that may also be combined into one single-dash cluster such as `-la`. */
	readonly clusterLetters?: string;
	/** When false, every argument must be an option; there are no paths or patterns. */
	readonly positionals?: false;
}

const GIT_SUBCOMMANDS: Readonly<Record<string, OptionSpec>> = {
	status: { flags: ["-s", "--short", "-b", "--branch", "--porcelain"] },
	diff: { flags: ["--stat", "--name-only", "--name-status", "--cached", "--staged", "--"], attached: new Map([["-U", COUNT]]) },
	log: {
		flags: ["--oneline", "--stat", "--name-only", "--name-status", "-p", "--graph", "--decorate", "--"],
		valued: new Map([["-n", COUNT]]),
		longValued: new Map([["--max-count", COUNT]]),
	},
	show: { flags: ["--stat", "--name-only", "--name-status", "--oneline", "-p", "--"] },
	blame: { flags: ["-w", "--"], valued: new Map([["-L", WORD]]) },
	"rev-parse": { flags: ["--abbrev-ref", "--short", "--show-toplevel", "--verify"] },
	"ls-files": { flags: ["-m", "-o", "--others", "--exclude-standard", "--cached"] },
	branch: { flags: ["--list", "-a", "-r", "-v", "--show-current"], positionals: false },
	grep: { flags: ["-n", "-i", "-l", "-w", "--"], valued: new Map([["-e", WORD]]) },
};

const PROGRAMS: Readonly<Record<string, OptionSpec>> = {
	rg: {
		flags: ["-n", "-i", "-S", "-w", "-l", "-c", "-F", "--hidden", "--no-ignore", "--"],
		valued: new Map([["-e", WORD], ["-t", WORD], ["-A", COUNT], ["-B", COUNT], ["-C", COUNT]]),
	},
	fd: { flags: ["-H", "-I", "--"], valued: new Map([["-t", FD_TYPE], ["-e", WORD], ["-d", COUNT]]) },
	file: { flags: ["-b", "-L"] },
	ls: { flags: ["-l", "-a", "-A", "-h", "-1", "-R"], clusterLetters: "laAh1R" },
	cat: { flags: ["-n"] },
	head: { valued: new Map([["-n", COUNT], ["-c", COUNT]]) },
	tail: { valued: new Map([["-n", COUNT], ["-c", COUNT]]) },
	wc: { flags: ["-l", "-w", "-c"] },
	stat: {},
	pwd: {},
};

function isCluster(argument: string, letters: string | undefined): boolean {
	if (letters === undefined || argument.length < 2 || argument.startsWith("--")) return false;
	return [...argument.slice(1)].every((letter) => letters.includes(letter));
}

/** Return true when every argument is a listed option, a valid value for one, or (if allowed) a non-option word. */
function argumentsAllowed(args: readonly string[], spec: OptionSpec): boolean {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]!;
		if (!argument.startsWith("-")) {
			if (spec.positionals === false) return false;
			continue;
		}
		if (spec.flags?.includes(argument) === true || isCluster(argument, spec.clusterLetters)) continue;
		if (argument.startsWith("--")) {
			const equals = argument.indexOf("=");
			const check = equals < 0 ? undefined : spec.longValued?.get(argument.slice(0, equals));
			if (check === undefined || !check(argument.slice(equals + 1))) return false;
			continue;
		}
		const name = argument.slice(0, 2);
		const attached = argument.slice(2);
		const attachedOnly = spec.attached?.get(name);
		if (attachedOnly !== undefined) {
			if (!attachedOnly(attached)) return false;
			continue;
		}
		const check = spec.valued?.get(name);
		if (check === undefined) return false;
		if (attached.length > 0) {
			if (!check(attached)) return false;
			continue;
		}
		const value = args[index + 1];
		if (value === undefined || !check(value)) return false;
		index += 1;
	}
	return true;
}

function gitIsReadOnly(args: readonly string[]): boolean {
	let index = 0;
	while (args[index] === "--no-pager") index += 1;
	const subcommand = args[index];
	if (subcommand === undefined || !Object.hasOwn(GIT_SUBCOMMANDS, subcommand)) return false;
	return argumentsAllowed(args.slice(index + 1), GIT_SUBCOMMANDS[subcommand]!);
}

/** Return true only for a single simple command the runtime treats as read-only. */
export function isReadOnlyShellCommand(command: unknown): boolean {
	if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) return false;
	if (!ALLOWED_CHARACTERS.test(command)) return false;
	const words = command.split(/[ \t]+/).filter((word) => word.length > 0);
	const [program, ...args] = words;
	if (program === undefined) return false;
	if (program === "git") return gitIsReadOnly(args);
	if (!Object.hasOwn(PROGRAMS, program)) return false;
	return argumentsAllowed(args, PROGRAMS[program]!);
}
