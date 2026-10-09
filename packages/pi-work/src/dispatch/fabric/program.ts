import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const FABRIC_DISPATCH_PROGRAM_SOURCE = "return await agents.run({ task: input.task, name: input.name, model: input.model, thinking: input.thinking, cwd: input.cwd, worktree: input.worktree, writableRoots: input.writableRoots, shell: input.shell, schema: input.schema, systemPrompt: input.systemPrompt });";

// Fabric hashes canonical JSON (sorted keys), excluding name and metadata.
// This fixed program has no inputSchema; digest parity is guarded by its test.
export const FABRIC_DISPATCH_PROGRAM_DIGEST = createHash("sha256").update(JSON.stringify({
	code: FABRIC_DISPATCH_PROGRAM_SOURCE,
	kernel: "typescript",
	kind: "fabric",
})).digest("hex");

export interface FabricDispatchProgram {
	readonly ref: string;
	readonly digest: string;
	readonly path: string;
	readonly created: boolean;
}

/** Bootstrap in the supplied project root (Fabric's PI_FABRIC_PROJECT_ROOT or cwd). */
export async function ensureFabricDispatchProgram(projectRoot: string): Promise<FabricDispatchProgram> {
	const directory = path.join(projectRoot, ".pi", "fabric", "programs");
	const digest = FABRIC_DISPATCH_PROGRAM_DIGEST;
	const file = path.join(directory, `${digest}.json`);
	// Full digest refs resolve directly in Fabric without a shared index update.
	const result = { ref: digest, digest, path: file };
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${digest}.${randomUUID()}.tmp`);
	// Records run as candidate unless a user promotes them. Never promote here.
	await writeFile(temporary, `${JSON.stringify({
		version: 1, digest, name: "pi-work-dispatch", kind: "fabric",
		kernel: "typescript", code: FABRIC_DISPATCH_PROGRAM_SOURCE,
		createdAt: Date.now(), status: "candidate",
	}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	try {
		try {
			// Atomic publication without overwriting an existing (even malformed)
			// record, including one created or promoted by a concurrent caller.
			await link(temporary, file);
			return { ...result, created: true };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				return { ...result, created: false };
			}
			throw error;
		}
	} finally {
		await unlink(temporary);
	}
}
