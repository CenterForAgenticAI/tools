import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyShellCommand } from "../src/modes/read-only-shell.js";

function allows(command: string): void {
	assert.equal(isReadOnlyShellCommand(command), true, `expected ${JSON.stringify(command)} to be allowed`);
}

function refuses(command: unknown): void {
	assert.equal(isReadOnlyShellCommand(command), false, `expected ${JSON.stringify(command)} to be refused`);
}

test("simple read-only commands are allowed", () => {
	for (const command of [
		"git diff",
		"rg foo src",
		"git status",
		"git --no-pager log -n 5 --oneline",
		"git show HEAD^1:src/a.ts",
		"git diff --stat origin/main...HEAD",
		"git blame -L 10,20 src/a.ts",
		"git rev-parse HEAD",
		"git ls-files src",
		"git grep -n foo",
		"git branch",
		"git branch --list",
		"git branch -a -v",
		"git branch --show-current",
		"rg -n foo src",
		"rg -tts foo",
		"fd -e ts . src",
		"ls -la src",
		"cat README.md",
		"head -n 20 a.txt",
		"tail -n 5 a.txt",
		"wc -l a.txt",
		"pwd",
		"stat a.txt",
		"file a.txt",
		"  git\tdiff  ",
	]) allows(command);
});

test("non-strings, empty, long and multi-line commands are refused", () => {
	for (const command of [undefined, null, 7, ["git", "diff"], { command: "git diff" }, "", "   ", "git diff\nrm a", "git diff\rrm a", "git diff\0", `cat ${"a".repeat(1000)}`]) {
		refuses(command);
	}
	allows(`cat ${"a".repeat(1000 - 4)}`);
});

test("any shell syntax or quote character is refused", () => {
	for (const command of [
		"git diff; rm a",
		"cat a > b",
		"cat a >> b",
		"cat < a",
		"echo $(id)",
		"cat $HOME",
		"cat `id`",
		"git diff && rm a",
		"git diff & rm a",
		"git diff | sh",
		"cat (a)",
		"cat {a,b}",
		"cat a\\ b",
		"cat !1",
		"cat *.ts",
		"cat a?",
		"cat [ab]",
		"cat ~/x",
		"cat a #b",
		"cat 'a'",
		"cat \"a\"",
		"cat a\u0007",
		"cat é",
	]) refuses(command);
});

test("only the listed programs are allowed, by bare name", () => {
	for (const command of ["sh -c x", "bash -c ls", "echo hi", "rm a", "env git diff", "FOO=1 git diff", "/usr/bin/git diff", "./git diff", "sudo cat a", "xargs cat", "find . -delete", "sed -i s/a/b/ a", "Git diff"]) {
		refuses(command);
	}
});

test("git allows only listed subcommands and only --no-pager before them", () => {
	for (const command of [
		"git",
		"git --no-pager",
		"git commit -m x",
		"git checkout .",
		"git restore a",
		"git apply x.patch",
		"git stash",
		"git push",
		"git config core.pager x",
		"git -c core.pager=sh log",
		"git -C src diff",
		"git --git-dir=x status",
		"git -p log",
		"git branch -d main",
		"git branch -D main",
		"git branch new-branch",
		"git branch -m a b",
		"git branch --set-upstream-to=origin/main",
		"git branch --list feature",
	]) refuses(command);
});

test("git refuses options that write a file or run another program, including abbreviations and clusters", () => {
	for (const command of [
		"git diff --output=x",
		"git diff --output x",
		"git log --output-directory=x",
		"git diff --ext-diff",
		"git diff --ext",
		"git show --textconv HEAD",
		"git show --textc HEAD",
		"git grep -O foo",
		"git grep -Ovim foo",
		"git grep -iO foo",
		"git grep -o foo",
		"git grep --open-files-in-pager foo",
		"git grep --open foo",
		"git log --exec=x",
		"git --no-pager diff --output=x",
	]) refuses(command);
});

test("rg refuses preprocessors, compressed search and program options", () => {
	for (const command of ["rg --pre sh x", "rg --pre=sh x", "rg --pre-glob a x", "rg --search-zip x", "rg -z x", "rg -iz x", "rg --hostname-bin x y"]) {
		refuses(command);
	}
});

test("fd refuses exec options, including clusters", () => {
	for (const command of ["fd -x rm", "fd -X rm", "fd -xrm", "fd -Hx rm", "fd --exec rm", "fd --exec=rm", "fd --exec-batch rm", "fd --exec-batch=rm"]) {
		refuses(command);
	}
});

test("file refuses compiling a magic file, which writes one", () => {
	for (const command of ["file -C -m magic", "file -zC", "file --compile -m magic"]) refuses(command);
});

const REVIEWER_SIDE_EFFECT_COMMANDS = ["git log --show-signature", "git log --format=%GG", "file -S -z a.Z", "file -p x", "fd -l x"];

test("options that run gpg, a decompressor or ls, or change a file's times, are refused", () => {
	for (const command of [
		...REVIEWER_SIDE_EFFECT_COMMANDS,
		"git log --pretty=format:%GG",
		"git show --show-signature HEAD",
		"git show --format=%GG HEAD",
		"file -S a",
		"file -z a.Z",
		"file -Sz a.Z",
		"file --preserve-date x",
		"fd --list-details x",
		"fd -Hl x",
	]) refuses(command);
});

test("each program refuses an option it does not list", () => {
	for (const command of [
		"git --paginate log",
		"git status --ignored",
		"git diff --no-index a b",
		"git diff --color-words",
		"git log --all",
		"git log --max-count 5",
		"git show --pretty=raw HEAD",
		"git blame -M a.ts",
		"git rev-parse --git-path config",
		"git ls-files --debug",
		"git grep --threads=2 foo",
		"git branch --contains HEAD",
		"rg --pretty foo",
		"rg -ni foo",
		"rg -g src/a.ts foo",
		"rg --follow foo",
		"fd --follow x",
		"fd -L x",
		"file -i a",
		"ls --color=always",
		"ls -lZ",
		"cat -A a",
		"cat -",
		"head -v a",
		"tail -f a",
		"tail -F a",
		"tail --follow=name a",
		"wc --files0-from=list",
		"stat -c %n a",
		"pwd -P",
	]) refuses(command);
});

test("an option value is consumed as a value, must be present, and must not look like an option", () => {
	for (const command of [
		"git --no-pager log -n 5",
		"git log -n5",
		"git log --max-count=5",
		"git diff -U3",
		"git blame -L10,20 a.ts",
		"git grep -e foo",
		"rg -e foo src",
		"rg -t ts foo",
		"rg -A3 -B 2 -C1 foo",
		"fd -t f x",
		"fd -td x",
		"fd -t l -d 2 -e ts x",
		"head -n20 a",
		"head -c 100 a",
		"tail -n 5 a",
		"wc -l -w -c a",
		"cat -n a",
		"file -b -L a",
		"ls -lahR1A src",
		"git ls-files -m -o --others --exclude-standard --cached",
		"git rev-parse --abbrev-ref --short --verify HEAD",
		"git rev-parse --show-toplevel",
		"git status -s -b --porcelain",
		"git show --stat --oneline -p HEAD -- a.ts",
		"git log --oneline --graph --decorate --stat --name-only -p -- a.ts",
	]) allows(command);
	for (const command of [
		"git log -n",
		"git log -n x",
		"git log -n -5",
		"git log -n5x",
		"git log --max-count=",
		"git log --max-count=5x",
		"git diff -U-1",
		"git diff -U",
		"git diff -U 3",
		"git blame -L",
		"git blame -L --output=x a.ts",
		"git grep -e",
		"git grep -e --open-files-in-pager",
		"rg -e",
		"rg -A x foo",
		"rg -C +3 foo",
		"fd -t x x",
		"fd -t e x",
		"fd -t file x",
		"fd -d x",
		"fd -e",
		"head -n +5 a",
		"head -n",
		"tail -c -5 a",
		"ls -",
	]) refuses(command);
});
