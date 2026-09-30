import type { ArtifactRef, JsonValue, RunId } from "../model.js";
import { sha256 } from "./compiler.js";

/**
 * Deciding what an artifact is, without writing one.
 *
 * A node's output may declare `storage: artifact`. The full body then leaves
 * state entirely and state keeps a reference: URI, media type, byte length,
 * SHA-256, and a bounded preview
 * ([0006](../../.spec/0006-runtime-state-and-durability.md) §5,
 * [0011](../../.spec/0011-data-contracts.md) §8.3).
 *
 * **The declaration is the threshold** (D-058). There is no byte trigger that
 * externalises a `storage: state` output behind the author's back, because that
 * would make a node's state shape — and so every routing condition over that
 * path — depend on how large the output happened to be. Oversized state is
 * already loud: `maxStateBytes` and `statePolicy.paths[].maxBytes` halt the run
 * with `RUN-STATE-BYTES`.
 */

/**
 * How much of a body the preview keeps.
 *
 * [0011](../../.spec/0011-data-contracts.md) §8.3 said "bounded" without a
 * bound, which is unbuildable; 512 characters is the bound (D-058). It is for
 * display, and routing MUST NOT read it — enforced at compile time by
 * `E-ROUTING-ON-ARTIFACT-PREVIEW`.
 */
export const ARTIFACT_PREVIEW_CHARS = 512;

export interface ArtifactBody {
	/** Exactly the bytes to write to the content-addressed file. */
	readonly content: string;
	readonly ref: ArtifactRef;
}

/**
 * The bytes an artifact holds, and the reference state keeps instead.
 *
 * A string body is stored as it stands, so a report stays readable in the run
 * directory rather than becoming a JSON-quoted blob. Anything else is
 * serialised.
 */
export function artifactFor(runId: RunId, value: JsonValue): ArtifactBody {
	const isText = typeof value === "string";
	const content = isText ? value : JSON.stringify(value);
	const digest = sha256(content);
	return {
		content,
		ref: {
			uri: `graph-run://${runId}/artifacts/${digest}`,
			mediaType: isText ? "text/plain" : "application/json",
			// The stored bytes, so a reader can check the file it is pointed at.
			bytes: byteLength(content),
			sha256: digest,
			preview: content.length > ARTIFACT_PREVIEW_CHARS ? `${content.slice(0, ARTIFACT_PREVIEW_CHARS)}…` : content,
		},
	};
}

/** Whether a value in state is an artifact reference rather than the body itself. */
export function isArtifactRef(value: unknown): value is ArtifactRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.uri === "string" && candidate.uri.startsWith("graph-run://")
		&& typeof candidate.sha256 === "string" && typeof candidate.bytes === "number" && typeof candidate.preview === "string";
}

/** UTF-8 byte length, without `Buffer`: this layer may not import a Node API. */
export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}
