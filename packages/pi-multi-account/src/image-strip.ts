/**
 * Opt-in removal of old images from outgoing `unified` and Anthropic alias
 * requests.
 *
 * STOPGAP: remove this module and its call sites once pi-context-aware owns
 * media folding (see UPSTREAM.md). Keep accepting and ignoring the
 * `imageStripping` config key after removal: the first explicit config write
 * materializes it, so rejecting it would turn saved configs malformed.
 *
 * The context compressor picks a payload protocol from the session model's
 * `api`. For `unified` and for Anthropic aliases that `api` names no known
 * protocol, so it strips nothing, and a session full of screenshots exceeds the
 * provider limit on every turn. This module works one layer earlier, on the Pi
 * context handed to the physical provider. Pi messages have one shape for every
 * provider, so the same rule is correct for Anthropic, Codex, OpenAI, and
 * Antigravity attempts alike, and it reaches images inside tool results too.
 *
 * The caller's context is never mutated: every changed message and array is a
 * fresh copy, so the session history and its file keep every image.
 */

/** Operator policy. Off unless `enabled` is `true`. */
export interface ImageStripPolicy {
	readonly enabled: boolean;
	/** Image-bearing messages, counted from the newest, that keep their images. */
	readonly keepNewest: number;
}

export const DEFAULT_IMAGE_STRIP_KEEP_NEWEST = 8;
export const MAX_IMAGE_STRIP_KEEP_NEWEST = 1000;

export const DEFAULT_IMAGE_STRIP_POLICY: ImageStripPolicy = Object.freeze({
	enabled: false,
	keepNewest: DEFAULT_IMAGE_STRIP_KEEP_NEWEST,
});

/** Reads the live policy for one request, so a config reload applies next call. */
export type ImageStripPolicyReader = () => ImageStripPolicy | undefined;

/** A reader that throws counts as off: the policy can never break a request. */
export function readImageStripPolicy(
	reader: ImageStripPolicyReader | undefined,
): ImageStripPolicy | undefined {
	if (reader === undefined) return undefined;
	try {
		return reader();
	} catch {
		return undefined;
	}
}

/** Text that replaces each run of removed images in one message. */
export const IMAGE_STRIP_PLACEHOLDER = "[image removed to fit the request limit]";

type Block = { readonly type?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageBlock(block: unknown): boolean {
	return isRecord(block) && block.type === "image";
}

function hasImage(message: unknown): boolean {
	return isRecord(message) && Array.isArray(message.content) && message.content.some(isImageBlock);
}

/** Replaces each run of adjacent image blocks with one placeholder text block. */
function withoutImages(content: readonly unknown[]): unknown[] {
	const next: unknown[] = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (!isImageBlock(block)) {
			next.push(block);
			previousWasPlaceholder = false;
			continue;
		}
		if (!previousWasPlaceholder) next.push({ type: "text", text: IMAGE_STRIP_PLACEHOLDER });
		previousWasPlaceholder = true;
	}
	return next;
}

/**
 * Returns `context` with the images of every image-bearing message except the
 * newest `keepNewest` replaced by {@link IMAGE_STRIP_PLACEHOLDER}.
 *
 * Returns the same object, untouched, when the policy is off or absent, when
 * the context has no message list, or when nothing is old enough to strip.
 * That identity is what keeps a disabled policy byte-identical.
 */
export function stripOldImages<T>(context: T, policy: ImageStripPolicy | undefined): T {
	if (policy?.enabled !== true) return context;
	if (!isRecord(context) || !Array.isArray(context.messages)) return context;
	const messages = context.messages as readonly unknown[];
	const keep = policy.keepNewest;
	let seen = 0;
	let cutoff = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (!hasImage(messages[index])) continue;
		seen += 1;
		if (seen > keep) {
			cutoff = index;
			break;
		}
	}
	if (cutoff < 0) return context;
	const stripped = messages.map((message, index) => {
		if (index > cutoff || !hasImage(message)) return message;
		const record = message as Record<string, unknown>;
		return { ...record, content: withoutImages(record.content as readonly Block[]) };
	});
	return { ...context, messages: stripped } as T;
}
