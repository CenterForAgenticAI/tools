/** Hold directory descriptors throughout destructive operations; never follow store symlinks. */
import fs from "node:fs";
import path from "node:path";

export function withStoreDirectory<T>(agentDir: string, directory: string, action: (held: string) => T): T {
	const root = fs.realpathSync.native(agentDir);
	const relative = path.relative(path.resolve(agentDir), path.resolve(directory));
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path is outside profile stores");
	const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
	let fd = fs.openSync(root, flags);
	try {
		// No pathname fallback: without descriptor paths a concurrent rename can redirect deletion.
		const descriptorRoot = ["/proc/self/fd", "/dev/fd"].find((candidate) => {
			try {
				const info = fs.statSync(`${candidate}/${fd}/.`) as unknown as { ino: number; dev: number };
				const held = fs.fstatSync(fd);
				return info.ino === held.ino && info.dev === held.dev;
			} catch { return false; }
		});
		if (!descriptorRoot) throw new Error("Platform cannot safely delete through held directories");
		for (const part of relative.split(path.sep).filter(Boolean)) {
			const next = fs.openSync(`${descriptorRoot}/${fd}/${part}`, flags);
			fs.closeSync(fd);
			fd = next;
			const info = fs.fstatSync(fd);
			if (process.getuid && info.uid !== process.getuid()) throw new Error("Store directory belongs to another user");
		}
		return action(`${descriptorRoot}/${fd}`);
	} finally { fs.closeSync(fd); }
}

export function readStoreFile(file: string): string {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error("Not a private regular store file");
		return fs.readFileSync(fd, "utf8");
	} finally { fs.closeSync(fd); }
}

/** First line only, at most `limit` bytes: a header is small, a transcript can be hundreds of megabytes. */
export function readStoreHeader(file: string, limit = 64 * 1024): string {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error("Not a private regular store file");
		const chunks: Buffer[] = [];
		for (let total = 0; total < limit;) {
			const chunk = Buffer.alloc(Math.min(4096, limit - total));
			const read = fs.readSync(fd, chunk, 0, chunk.length, total);
			if (read === 0) break;
			const newline = chunk.subarray(0, read).indexOf(0x0a);
			chunks.push(chunk.subarray(0, newline === -1 ? read : newline));
			if (newline !== -1) break;
			total += read;
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally { fs.closeSync(fd); }
}

/** Missing files are already erased; unsafe paths and all other errors are surfaced. */
export function removeStoreFile(agentDir: string, file: string): void {
	try {
		withStoreDirectory(agentDir, path.dirname(file), (held) => {
			const target = path.join(held, path.basename(file));
			const info = fs.lstatSync(target);
			if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw new Error("Not a private regular store file");
			// unlink never follows a replaced final symlink; parent stays pinned to its descriptor.
			fs.unlinkSync(target);
		});
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Remove only an empty store directory, never a recursive tree or a redirected target. */
export function removeStoreDirectory(agentDir: string, directory: string): void {
	try {
		withStoreDirectory(agentDir, path.dirname(directory), (held) => {
			const target = path.join(held, path.basename(directory));
			if (!fs.lstatSync(target).isDirectory()) throw new Error("Not a real store directory");
			fs.rmdirSync(target);
		});
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Enumerate bounded-depth store directories, rejecting redirects rather than traversing them. */
export function storeDirectories(agentDir: string, base: string): string[] {
	const result: string[] = [];
	const walk = (directory: string, depth: number): void => {
		try {
			withStoreDirectory(agentDir, directory, (held) => {
				result.push(directory);
				if (depth === 0) return;
				for (const entry of fs.readdirSync(held, { withFileTypes: true })) {
					if (entry.isSymbolicLink()) throw new Error(`Redirected store: ${path.join(directory, entry.name)}`);
					if (entry.isDirectory()) walk(path.join(directory, entry.name), depth - 1);
				}
			});
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	};
	walk(base, 2);
	return result;
}
