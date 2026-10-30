/**
 * Identifier-shaped facts about a failure the closed lists did not name.
 *
 * A provider failure that classifies as `unknown` used to leave nothing to tell
 * one cause from another. These facts close that gap without copying provider
 * text: each value is either a short identifier that must match a strict
 * pattern, a bounded integer, a closed enum, or a truncated hash of the
 * normalized message. Anything that does not fit is dropped.
 */

import { createHash } from "node:crypto";

/** How an unmatched failure message starts. */
export const MESSAGE_FORMS = [
	"empty",
	"json",
	"codex-error",
	"status-prefixed",
	"markup",
	"plain-text",
] as const;

export type MessageForm = (typeof MESSAGE_FORMS)[number];

const MESSAGE_FORM_SET: ReadonlySet<string> = new Set(MESSAGE_FORMS);

/** A JavaScript error class name such as `TypeError` or `APIConnectionError`, at most 64 characters. */
const ERROR_NAME = /^(?=.{1,64}$)(?:[A-Z][A-Za-z]*)?(?:Error|Exception)$/;
/** A Node or undici system error code such as `ECONNRESET` or `ERR_STREAM_PREMATURE_CLOSE`. */
const NODE_ERROR_CODE = /^(?:E[A-Z]{2,15}|ERR_[A-Z0-9_]{1,60}|UND_ERR_[A-Z_]{1,40})$/;
/**
 * A provider error type or code such as `server_is_overloaded`: lowercase
 * snake_case words, as Anthropic and OpenAI spell them. No digits, so a hex or
 * base64 secret cannot pass; no hyphens, dots or spaces, so a slug, host name
 * or sentence cannot either.
 */
const PROVIDER_IDENTIFIER = /^(?=.{1,64}$)[a-z]+(?:_[a-z]+)*$/;
const MESSAGE_HASH = /^[0-9a-f]{12}$/;

/** Messages longer than this are measured but not parsed or hashed past it. */
const MAX_SCANNED_MESSAGE_LENGTH = 4_096;
/** The largest message length reported; longer messages report this value. */
export const MAX_REPORTED_MESSAGE_LENGTH = 65_536;

const CODEX_ERROR_PREFIX = "Codex error: ";
const HASH_DOMAIN = "pi-multi-account/failure-message/v1\n";

export interface ThrownIdentifiers {
	/** The thrown value's class name, when it matches the error-name pattern. */
	readonly errorName?: string;
	/** A Node system error code from the value or its direct `cause`. */
	readonly errorCode?: string;
}

export interface MessageIdentifiers {
	/** The provider error envelope's `error.type`, when identifier-shaped. */
	readonly envelopeType?: string;
	/** The envelope's `code`, or the code after `Codex error: `, when identifier-shaped. */
	readonly envelopeCode?: string;
	/** The message length in characters, capped at {@link MAX_REPORTED_MESSAGE_LENGTH}. */
	readonly messageLength?: number;
	readonly messageForm?: MessageForm;
	/** Twelve hex characters of a SHA-256 over the normalized message. */
	readonly messageHash?: string;
}

export function isErrorName(value: unknown): value is string {
	return typeof value === "string" && ERROR_NAME.test(value);
}

export function isNodeErrorCode(value: unknown): value is string {
	return typeof value === "string" && NODE_ERROR_CODE.test(value);
}

export function isProviderIdentifier(value: unknown): value is string {
	return typeof value === "string" && PROVIDER_IDENTIFIER.test(value);
}

export function isMessageForm(value: unknown): value is MessageForm {
	return typeof value === "string" && MESSAGE_FORM_SET.has(value);
}

export function isMessageHash(value: unknown): value is string {
	return typeof value === "string" && MESSAGE_HASH.test(value);
}

export function isReportedMessageLength(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= MAX_REPORTED_MESSAGE_LENGTH
	);
}

/** Reads one property; a throwing getter or proxy reads as absent. */
function read(value: unknown, key: string): unknown {
	try {
		return typeof value === "object" && value !== null
			? (value as Record<string, unknown>)[key]
			: undefined;
	} catch {
		return undefined;
	}
}

/** The class name and system error code of a thrown value. */
export function thrownIdentifiers(error: unknown): ThrownIdentifiers {
	const name = read(error, "name");
	const ownCode = read(error, "code");
	const code = isNodeErrorCode(ownCode) ? ownCode : read(read(error, "cause"), "code");
	return {
		...(isErrorName(name) ? { errorName: name } : {}),
		...(isNodeErrorCode(code) ? { errorCode: code } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object spanning the first `{` to the last `}`, if it parses. */
function embeddedObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed: unknown = JSON.parse(text.slice(start, end + 1));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `{error: {type, code}}` as Anthropic and OpenAI send it, or a top-level
 * `{code}` as a Responses error event sends it. A top-level `type` names the
 * event, not the error, so only a nested `error.type` counts.
 */
function envelopeIdentifiers(text: string): Pick<MessageIdentifiers, "envelopeType" | "envelopeCode"> {
	if (text.startsWith(CODEX_ERROR_PREFIX)) {
		const rest = text.slice(CODEX_ERROR_PREFIX.length).trim();
		if (isProviderIdentifier(rest)) return { envelopeCode: rest };
	}
	const object = embeddedObject(text);
	if (object === undefined) return {};
	const nested = read(object, "error");
	const type = isRecord(nested) ? read(nested, "type") : undefined;
	const code = isRecord(nested) ? read(nested, "code") : read(object, "code");
	return {
		...(isProviderIdentifier(type) ? { envelopeType: type } : {}),
		...(isProviderIdentifier(code) ? { envelopeCode: code } : {}),
	};
}

function messageForm(text: string): MessageForm {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "empty";
	if (trimmed.startsWith(CODEX_ERROR_PREFIX.trimEnd())) return "codex-error";
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
	if (/^\d{3}\b/.test(trimmed)) return "status-prefixed";
	if (trimmed.startsWith("<")) return "markup";
	return "plain-text";
}

/**
 * Removes the parts of a message that vary between occurrences of one cause:
 * long tokens that contain a digit (request IDs, UUIDs, keys) become `*`,
 * remaining digit runs become `#`, whitespace collapses and case folds.
 */
export function normalizeFailureMessage(text: string): string {
	return text
		.slice(0, MAX_SCANNED_MESSAGE_LENGTH)
		.replace(/[A-Za-z0-9_+/=.-]{16,}/g, (token) => (/\d/.test(token) ? "*" : token))
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** The short, stable hash two occurrences of one unmatched message share. */
export function failureMessageHash(text: string): string {
	return createHash("sha256")
		.update(HASH_DOMAIN + normalizeFailureMessage(text))
		.digest("hex")
		.slice(0, 12);
}

/**
 * Identifier facts from a failure message. Envelope identifiers are read from
 * any string; length, form and hash only when `unmatched`, meaning no closed
 * list named the message.
 */
export function messageIdentifiers(raw: unknown, unmatched: boolean): MessageIdentifiers {
	if (typeof raw !== "string") return {};
	const scanned = raw.length > MAX_SCANNED_MESSAGE_LENGTH ? undefined : raw;
	return {
		...(scanned === undefined ? {} : envelopeIdentifiers(scanned)),
		...(unmatched
			? {
					messageLength: Math.min(raw.length, MAX_REPORTED_MESSAGE_LENGTH),
					messageForm: messageForm(raw.slice(0, MAX_SCANNED_MESSAGE_LENGTH)),
					messageHash: failureMessageHash(raw),
				}
			: {}),
	};
}
