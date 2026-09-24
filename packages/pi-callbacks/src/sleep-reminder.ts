const MAX_COMMAND_LENGTH = 100_000;

type Token =
  | { kind: "word"; value: string; quoted: boolean }
  | { kind: "operator"; value: string };

type Structure =
  | { kind: "if"; phase: "condition" | "body" | "else" }
  | { kind: "group" }
  | { kind: "brace" }
  | { kind: "loop"; form: "condition"; active: boolean }
  | { kind: "loop"; form: "iterator"; active: boolean; phase: "name" | "after-name" | "after-name-newline" | "values" | "await-do" };

export interface LiteralSleepDetection {
  maxNonLoopSeconds: number | undefined;
  hasPositiveLoopSleep: boolean;
}

/**
 * Finds statically known sleep commands without executing or interpreting shell input.
 * Unknown shell syntax and durations are ignored so callers can fail closed.
 */
export function detectLiteralSleep(command: string): LiteralSleepDetection | undefined {
  if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) return undefined;
  const tokens = tokenize(command);
  if (tokens === undefined) return undefined;

  const structures: Structure[] = [];
  let commandPosition = true;
  let commandStartOperator: string | undefined;
  let commandComplete = false;
  let listHasCommand = false;
  let compoundCommandComplete = false;
  let maxNonLoopSeconds: number | undefined;
  let hasPositiveLoopSleep = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const iteratorFrame = structures.at(-1);
    if (iteratorFrame?.kind === "loop" && iteratorFrame.form === "iterator" && !iteratorFrame.active) {
      if (iteratorFrame.phase === "name") {
        if (token.kind !== "word" || token.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value)) return undefined;
        iteratorFrame.phase = "after-name";
        commandPosition = false;
        continue;
      }
      if (iteratorFrame.phase === "after-name") {
        if (token.kind === "word" && !token.quoted && token.value === "in") iteratorFrame.phase = "values";
        else if (token.kind === "operator" && token.value === "\n") iteratorFrame.phase = "after-name-newline";
        else if (token.kind === "operator" && token.value === ";") iteratorFrame.phase = "await-do";
        else return undefined;
        continue;
      }
      if (iteratorFrame.phase === "after-name-newline") {
        if (token.kind === "operator" && token.value === "\n") continue;
        if (token.kind === "word" && !token.quoted && token.value === "in") {
          iteratorFrame.phase = "values";
          continue;
        }
        if (token.kind !== "word" || token.quoted || token.value !== "do") return undefined;
        iteratorFrame.active = true;
        commandPosition = true;
        commandComplete = false;
        listHasCommand = false;
        compoundCommandComplete = false;
        commandStartOperator = undefined;
        continue;
      }
      if (iteratorFrame.phase === "values") {
        if (token.kind === "word") continue;
        if (token.value !== ";" && token.value !== "\n") return undefined;
        iteratorFrame.phase = "await-do";
        commandPosition = true;
        commandStartOperator = token.value;
        continue;
      }
      if (token.kind === "operator" && token.value === "\n") {
        commandStartOperator = token.value;
        continue;
      }
      if (token.kind !== "word" || token.quoted || token.value !== "do") return undefined;
      iteratorFrame.active = true;
      commandPosition = true;
      commandComplete = false;
      listHasCommand = false;
      compoundCommandComplete = false;
      commandStartOperator = undefined;
      continue;
    }
    if (token.kind === "operator") {
      if (token.value === "\n" && isContinuationOperator(commandStartOperator)) continue;
      if (isContinuationOperator(token.value)) {
        if (!commandComplete) return undefined;
        commandPosition = true;
        commandComplete = false;
        compoundCommandComplete = false;
        commandStartOperator = token.value;
        continue;
      }
      if (token.value === ";" || token.value === "&") {
        if (!commandComplete) return undefined;
        commandPosition = true;
        commandComplete = false;
        compoundCommandComplete = false;
        commandStartOperator = token.value;
        continue;
      }
      if (token.value === "\n") {
        commandPosition = true;
        commandComplete = false;
        compoundCommandComplete = false;
        commandStartOperator = token.value;
        continue;
      }
      if (token.value === "(" || token.value === "{") {
        if (!commandPosition || commandComplete) return undefined;
        structures.push({ kind: token.value === "(" ? "group" : "brace" });
        commandPosition = true;
        commandComplete = false;
        listHasCommand = false;
        compoundCommandComplete = false;
        commandStartOperator = undefined;
        continue;
      }
      if (token.value === ")") {
        if (structures.at(-1)?.kind !== "group" || !listHasCommand || isContinuationOperator(commandStartOperator)) return undefined;
        structures.pop();
        commandPosition = false;
        commandComplete = true;
        listHasCommand = true;
        compoundCommandComplete = true;
        commandStartOperator = undefined;
        continue;
      }
      if (token.value === "}") {
        if (structures.at(-1)?.kind !== "brace" || !listHasCommand || !isListTerminator(commandStartOperator)) return undefined;
        structures.pop();
        commandPosition = false;
        commandComplete = true;
        listHasCommand = true;
        compoundCommandComplete = true;
        commandStartOperator = undefined;
        continue;
      }
      return undefined;
    }

    if (!commandPosition) {
      if (compoundCommandComplete) return undefined;
      continue;
    }
    const precedingOperator = commandStartOperator;
    commandStartOperator = undefined;

    if (token.quoted) {
      commandPosition = false;
      commandComplete = true;
      listHasCommand = true;
      compoundCommandComplete = false;
      continue;
    }
    if (requiresListTerminator(token.value) && !isListTerminator(precedingOperator)) return undefined;

    if (token.value === "if") {
      structures.push({ kind: "if", phase: "condition" });
      commandPosition = true;
      commandComplete = false;
      listHasCommand = false;
      compoundCommandComplete = false;
      continue;
    }
    if (token.value === "case" || token.value === "esac") {
      return undefined;
    }
    if (token.value === "fi") {
      const structure = structures.at(-1);
      if (!listHasCommand || structure?.kind !== "if" || (structure.phase !== "body" && structure.phase !== "else")) return undefined;
      structures.pop();
      commandPosition = false;
      commandComplete = true;
      listHasCommand = true;
      compoundCommandComplete = true;
      continue;
    }
    if (token.value === "do") {
      const frame = structures.at(-1);
      if (!listHasCommand || frame?.kind !== "loop" || frame.form !== "condition" || frame.active) return undefined;
      frame.active = true;
      commandPosition = true;
      commandComplete = false;
      listHasCommand = false;
      compoundCommandComplete = false;
      continue;
    }
    if (token.value === "done") {
      const frame = structures.at(-1);
      if (!listHasCommand || frame?.kind !== "loop" || !frame.active) return undefined;
      structures.pop();
      commandPosition = false;
      commandComplete = true;
      listHasCommand = true;
      compoundCommandComplete = true;
      continue;
    }
    if (isLoopKeyword(token.value)) {
      if (token.value === "while" || token.value === "until") {
        structures.push({ kind: "loop", form: "condition", active: false });
        commandPosition = true;
      } else {
        structures.push({ kind: "loop", form: "iterator", active: false, phase: "name" });
        commandPosition = false;
      }
      commandComplete = false;
      listHasCommand = false;
      compoundCommandComplete = false;
      continue;
    }
    if (isControlBoundary(token.value)) {
      const structure = structures.at(-1);
      if (token.value === "then") {
        if (!listHasCommand || structure?.kind !== "if" || structure.phase !== "condition") return undefined;
        structure.phase = "body";
      } else if (token.value === "else") {
        if (!listHasCommand || structure?.kind !== "if" || structure.phase !== "body") return undefined;
        structure.phase = "else";
      } else if (token.value === "elif") {
        if (!listHasCommand || structure?.kind !== "if" || structure.phase !== "body") return undefined;
        structure.phase = "condition";
      } else if (token.value === "in") {
        return undefined;
      }
      commandPosition = true;
      commandComplete = false;
      listHasCommand = false;
      compoundCommandComplete = false;
      continue;
    }
    if (token.value === "sleep") {
      const argumentsStart = index + 1;
      let argumentsEnd = argumentsStart;
      while (argumentsEnd < tokens.length) {
        const argument = tokens[argumentsEnd]!;
        if (argument.kind === "operator") break;
        argumentsEnd++;
      }
      const duration = parseSleepDuration(tokens.slice(argumentsStart, argumentsEnd));
      if (duration !== undefined) {
        const inLoop = structures.some((structure) => structure.kind === "loop");
        if (inLoop) hasPositiveLoopSleep = true;
        else if (maxNonLoopSeconds === undefined || duration > maxNonLoopSeconds) maxNonLoopSeconds = duration;
      }
      index = argumentsEnd - 1;
      commandPosition = false;
      commandComplete = true;
      listHasCommand = true;
      compoundCommandComplete = false;
      continue;
    }

    commandPosition = false;
    commandComplete = true;
    listHasCommand = true;
    compoundCommandComplete = false;
  }

  if (isContinuationOperator(commandStartOperator)) return undefined;
  const lastToken = tokens.at(-1);
  if (lastToken?.kind === "operator" && lastToken.value === "&") return undefined;
  if (structures.length > 0) return undefined;
  if (maxNonLoopSeconds === undefined && !hasPositiveLoopSleep) return undefined;
  return { maxNonLoopSeconds, hasPositiveLoopSleep };
}

function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  let atTokenStart = true;

  while (index < command.length) {
    const character = command[index]!;
    if (character === " " || character === "\t" || character === "\r") {
      index++;
      atTokenStart = true;
      continue;
    }
    if (character === "\n") {
      tokens.push({ kind: "operator", value: "\n" });
      index++;
      atTokenStart = true;
      continue;
    }
    if (atTokenStart && character === "#") {
      while (index < command.length && command[index] !== "\n") index++;
      continue;
    }
    if (hasUnsupportedOperatorAt(command, index)) return undefined;
    const operator = readOperator(command, index);
    if (operator !== undefined) {
      tokens.push({ kind: "operator", value: operator.value });
      index += operator.length;
      atTokenStart = true;
      continue;
    }

    let value = "";
    let quoted = false;
    while (index < command.length) {
      const current = command[index]!;
      if (current === " " || current === "\t" || current === "\r" || current === "\n") break;
      if (hasUnsupportedOperatorAt(command, index)) return undefined;
      if (readOperator(command, index) !== undefined) break;
      if (current === "\\" || current === "`" || current === "$" || current === "<" || current === ">") return undefined;
      if (current === "'" || current === '"') {
        quoted = true;
        const quote = current;
        index++;
        let closed = false;
        while (index < command.length) {
          const quotedCharacter = command[index]!;
          if (quotedCharacter === quote) {
            index++;
            closed = true;
            break;
          }
          if (quotedCharacter === "\n") return undefined;
          if (quotedCharacter === "\\" || quotedCharacter === "`" || quotedCharacter === "$") return undefined;
          value += quotedCharacter;
          index++;
        }
        if (!closed) return undefined;
        continue;
      }
      if (current === "#" && value.length === 0) break;
      value += current;
      index++;
    }
    if (value.length > 0 || quoted) tokens.push({ kind: "word", value, quoted });
    atTokenStart = false;
  }
  return tokens;
}

function hasUnsupportedOperatorAt(command: string, index: number): boolean {
  return command.startsWith(";&", index);
}

function readOperator(command: string, index: number): { value: string; length: number } | undefined {
  for (const value of ["&&", "||", "|&", ";", "&", "|", "(", ")", "{", "}"]) {
    if (command.startsWith(value, index) && (value !== "{" || isShellTokenDelimiter(command[index + 1]))) {
      return { value, length: value.length };
    }
  }
  return undefined;
}

function isShellTokenDelimiter(value: string | undefined): boolean {
  return value === undefined || value === " " || value === "\t" || value === "\r" || value === "\n" || "|&;()<>".includes(value);
}

function parseSleepDuration(argumentsTokens: Token[]): number | undefined {
  if (argumentsTokens.length === 0) return undefined;
  let total = 0;
  for (const token of argumentsTokens) {
    if (token.kind !== "word" || token.quoted) return undefined;
    const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd])?$/.exec(token.value);
    if (match === null) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const unit = match[2];
    const multiplier = unit === "m" ? 60 : unit === "h" ? 3_600 : unit === "d" ? 86_400 : 1;
    total += amount * multiplier;
    if (!Number.isFinite(total)) return undefined;
  }
  return total > 0 ? total : undefined;
}

function isContinuationOperator(value: string | undefined): boolean {
  return value === "&&" || value === "||" || value === "|" || value === "|&";
}

function isListTerminator(value: string | undefined): boolean {
  return value === ";" || value === "\n" || value === "&";
}

function isLoopKeyword(value: string): boolean {
  return value === "while" || value === "until" || value === "for" || value === "select";
}

function requiresListTerminator(value: string): boolean {
  return value === "then" || value === "else" || value === "elif" || value === "fi" || value === "do" || value === "done";
}

function isControlBoundary(value: string): boolean {
  return value === "then" || value === "else" || value === "elif" || value === "fi" || value === "in";
}
