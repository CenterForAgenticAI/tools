import { isAbsolute } from "node:path";
import { Refusal } from "./result.ts";

/** Where a replica lives. Mirrors `N.ReplicaKind` in model/enums.json. */
export type ReplicaKind = "local" | "ssh" | "s3";
export const REPLICA_KINDS: readonly ReplicaKind[] = ["local", "ssh", "s3"];

/**
 * A replica's `encrypt` setting. Absent: the kind's default. `false`: never
 * encrypt. `{ recipients }`: encrypt to these age recipients.
 */
export type Encrypt = false | { readonly recipients: readonly string[] };

interface Common {
	readonly id: string;
	readonly encrypt?: Encrypt;
}
/** A directory on this machine, such as a USB disk or a mounted volume. */
export interface LocalReplica extends Common {
	readonly kind: "local";
	readonly path: string;
}
/** A repository another of your devices advertises, reached over SSH. */
export interface SshReplica extends Common {
	readonly kind: "ssh";
	readonly host: string;
	readonly repository: string;
}
/** An S3 bucket and prefix, written with the aws or rclone CLI. */
export interface S3Replica extends Common {
	readonly kind: "s3";
	readonly uri: string;
	readonly tool: "aws" | "rclone";
	/** The rclone remote that holds the S3 credentials (rclone only). */
	readonly remote?: string;
}
export type Replica = LocalReplica | SshReplica | S3Replica;

export const REPLICA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HOST_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
const S3_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/[A-Za-z0-9!_.*'()/-]*)?$/;
const RCLONE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// age X25519 and plugin recipients, and the SSH public keys age accepts.
const RECIPIENT = /^(age1[0-9a-z]{20,200}|ssh-ed25519 [A-Za-z0-9+/]+={0,2}|ssh-rsa [A-Za-z0-9+/]+={0,2})$/;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** Encryption on by default for each kind. Mirrors `encryptDefault` in model/Domain.bend. */
function encryptDefault(kind: ReplicaKind): boolean {
	return kind === "s3";
}

/**
 * Whether a replica encrypts. Mirrors `encrypts` in model/Domain.bend: an
 * S3 replica encrypts unless told otherwise (L13), and an explicit setting
 * beats the kind's default (L14).
 */
export function encrypts(kind: ReplicaKind, encrypt: Encrypt | undefined): boolean {
	return encrypt === undefined ? encryptDefault(kind) : encrypt !== false;
}

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEncrypt(raw: unknown, where: string): Encrypt | undefined {
	if (raw === undefined || raw === false) return raw;
	if (!record(raw) || Object.keys(raw).some((k) => k !== "recipients") || !Array.isArray(raw.recipients) || raw.recipients.length === 0) {
		throw new Refusal(`${where}.encrypt must be false or { recipients: [age recipient, ...] }`);
	}
	const recipients: string[] = [];
	for (const r of raw.recipients) {
		if (typeof r !== "string" || !RECIPIENT.test(r)) throw new Refusal(`${where}.encrypt: not an age recipient: ${typeof r === "string" && !UNPRINTABLE.test(r) ? JSON.stringify(r) : "(unprintable)"}`);
		recipients.push(r);
	}
	return { recipients };
}

function keys(raw: Record<string, unknown>, allowed: readonly string[], where: string): void {
	const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
	if (extra.length > 0) throw new Refusal(`${where} has unknown keys: ${extra.join(", ")}`);
}

/**
 * Check one replica and copy only its named fields. An S3 replica encrypts by
 * default, so it needs recipients unless `encrypt` is false.
 */
export function parseReplica(raw: unknown, index = 0): Replica {
	if (!record(raw) || typeof raw.id !== "string" || !REPLICA_ID.test(raw.id)) throw new Refusal(`replicas[${String(index)}] needs a valid id`);
	const id = raw.id;
	const where = `replica ${id}`;
	const encrypt = parseEncrypt(raw.encrypt, where);
	const withEncrypt = encrypt === undefined ? {} : { encrypt };
	switch (raw.kind) {
		case "local": {
			keys(raw, ["id", "kind", "path", "encrypt"], where);
			if (typeof raw.path !== "string" || UNPRINTABLE.test(raw.path) || !isAbsolute(raw.path)) throw new Refusal(`${where}: path must be an absolute path without control characters`);
			return { id, kind: "local", path: raw.path, ...withEncrypt };
		}
		case "ssh": {
			keys(raw, ["id", "kind", "host", "repository", "encrypt"], where);
			if (typeof raw.host !== "string" || !HOST_LABEL.test(raw.host)) throw new Refusal(`${where}: host must be a Tailscale short name, such as good-kite-studio`);
			if (typeof raw.repository !== "string" || !REPLICA_ID.test(raw.repository)) throw new Refusal(`${where}: repository must be a repository ID the host advertises`);
			return { id, kind: "ssh", host: raw.host, repository: raw.repository, ...withEncrypt };
		}
		case "s3": {
			keys(raw, ["id", "kind", "uri", "tool", "remote", "encrypt"], where);
			if (typeof raw.uri !== "string" || !S3_URI.test(raw.uri.replace(/\/+$/, ""))) throw new Refusal(`${where}: uri must be s3://BUCKET or s3://BUCKET/PREFIX`);
			const tool = raw.tool ?? "aws";
			if (tool !== "aws" && tool !== "rclone") throw new Refusal(`${where}: tool must be aws or rclone`);
			if (raw.remote !== undefined && (tool !== "rclone" || typeof raw.remote !== "string" || !RCLONE_REMOTE.test(raw.remote))) throw new Refusal(`${where}: remote is an rclone remote name and needs tool rclone`);
			if (encrypt === undefined) throw new Refusal(`${where}: an s3 replica encrypts by default; give age recipients, or set encrypt to false`);
			return { id, kind: "s3", uri: raw.uri.replace(/\/+$/, ""), tool, ...(raw.remote === undefined ? {} : { remote: raw.remote as string }), ...withEncrypt };
		}
		default:
			throw new Refusal(`${where}: kind must be ${REPLICA_KINDS.join(", ")}`);
	}
}

/** Check config.json's `replicas` list: every entry valid, every ID unique. */
export function parseReplicas(raw: unknown): Replica[] {
	if (!Array.isArray(raw)) throw new Refusal("replicas must be a list");
	const out = raw.map((r, i) => parseReplica(r, i));
	const seen = new Set<string>();
	for (const r of out) {
		if (seen.has(r.id)) throw new Refusal(`replica ID is used twice: ${r.id}`);
		seen.add(r.id);
	}
	return out;
}
