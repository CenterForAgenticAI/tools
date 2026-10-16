import fs from "node:fs";
import path from "node:path";
import { erasedSessionIds } from "./database.js";
import { readStoreHeader, storeDirectories, withStoreDirectory } from "./files.js";
import { paritySessionFile } from "../parity/records.js";
import type { ErasureSession } from "./session-erasure.js";

export interface RestoredSession extends ErasureSession { readonly files: readonly string[] }

/** Exact SDK timestamp/id grammar, not suffix matching against another id. */
export function sessionIdFromFileName(file: string): string | undefined {
	const base = path.basename(file);
	return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/u.exec(base)?.[1]
		?? (base.endsWith(".jsonl") ? base.slice(0, -6) : undefined);
}

/** Read-only detection. The ledger stores ids only; do not retain erased paths or content. */
export function restoredErasedSessions(agentDir: string, current?: ErasureSession): RestoredSession[] {
	const ids = erasedSessionIds(agentDir);
	// Nothing was ever erased, so nothing can have returned. Skip reading every transcript.
	if (ids.size === 0) return [];
	const candidates = new Map<string, { id: string; path: string; files: string[] }>();
	const add = (id: string, transcript: string, file: string) => {
		if (!ids.has(id) || !fs.existsSync(file)) return;
		const key = `${id}\0${transcript}`;
		let candidate = candidates.get(key);
		if (!candidate) { candidate = { id, path: transcript, files: [] }; candidates.set(key, candidate); }
		if (!candidate.files.includes(file)) candidate.files.push(file);
	};
	for (const directory of storeDirectories(agentDir, path.join(agentDir, "sessions"))) {
		withStoreDirectory(agentDir, directory, (held) => {
			const headerIds = new Map<string, string | undefined>();
			for (const name of fs.readdirSync(held)) {
				const side = name.endsWith(".jsonl.acp.json");
				if (!side && !name.endsWith(".jsonl")) continue;
				const base = side ? name.slice(0, -9) : name;
				const transcript = path.join(directory, base);
				if (!headerIds.has(base)) {
					let id: string | undefined;
					try {
						const header = JSON.parse(readStoreHeader(path.join(held, base))) as { type?: string; id?: string };
						if (header.type === "session") id = header.id;
					} catch { /* A side-only restore still has the SDK filename's id. */ }
					headerIds.set(base, id ?? sessionIdFromFileName(base));
				}
				const id = headerIds.get(base);
				if (id) add(id, transcript, path.join(directory, name));
			}
		});
	}
	if (current) for (const file of [current.path, `${current.path}.acp.json`]) add(current.id, current.path, file);
	for (const id of ids) {
		const transcript = [...candidates.values()].find((candidate) => candidate.id === id)?.path ?? path.join(agentDir, "sessions", `${id}.jsonl`);
		add(id, transcript, paritySessionFile(agentDir, id));
	}
	return [...candidates.values()];
}
