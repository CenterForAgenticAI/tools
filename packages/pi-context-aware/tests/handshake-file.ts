import * as fs from "node:fs";

/**
 * Write a handshake file so a concurrent reader never sees it empty or partial:
 * write a sibling temporary file, then rename it onto the target (atomic on one filesystem).
 */
export function writeFileAtomic(file: string, text: string): void {
	const temporary = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(temporary, text);
	fs.renameSync(temporary, file);
}

/**
 * The same function as source text for child scripts generated inside tests. The script must have
 * `fs` in scope (an `import * as fs`, `import fs` or `const fs = require(...)`).
 */
export const ATOMIC_WRITE_SOURCE = `function writeFileAtomic(file, text) {
  const temporary = file + ".tmp-" + process.pid;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}`;
