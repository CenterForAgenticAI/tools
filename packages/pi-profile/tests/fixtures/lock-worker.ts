// Child process for the lock stress test: enters the lock N times and
// records overlaps through an O_EXCL marker file.
import { openSync, closeSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { withProfileLock } from "../../src/core/lock.ts";

const [dir, rounds, out] = process.argv.slice(2) as [string, string, string];
const marker = join(dir, "inside");
let entered = 0;
for (let i = 0; i < Number(rounds); i++) {
	try {
		withProfileLock(dir, () => {
			let fd: number;
			try {
				fd = openSync(marker, "wx");
			} catch {
				appendFileSync(out, "overlap\n");
				return;
			}
			closeSync(fd);
			const until = Date.now() + 2;
			while (Date.now() < until) {
				// hold the lock briefly
			}
			unlinkSync(marker);
			entered++;
		});
	} catch {
		// refused: another process holds the lock
	}
}
appendFileSync(out, `entered ${entered}\n`);
