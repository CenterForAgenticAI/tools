import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { isHubName } from "./manifest.ts";
import type { Layout } from "./paths.ts";
import { isPin } from "./piversion.ts";
import { printable } from "./repo.ts";
import { Refusal } from "./result.ts";

/**
 * The Pi version pin of each hub on this host (issue 34),
 * `state/sync/pin.json`, machine-local, never synced:
 * `{ "schemaVersion": 1, "hubs": { HUB: { "pin"?: PIN, "agreed"?: PIN } } }`.
 *
 * `pin` is the pin this host uses: `run` and `doctor` compare the Pi here
 * with it, so neither reads the hub. `agreed` is the pin the hub held when
 * this host last pulled from or pushed to it (absent: no pin). The pin is
 * not pushed yet while `pin` differs from `agreed`; then `sync push`
 * writes it to the hub. When the hub's pin moved meanwhile, `sync pull`
 * refuses until `--theirs`, `--keep-local` or `pi-profile pin` settles it
 * (`pinDiverged`). `pi-profile pin` writes
 * `pin`; `sync pull` and `sync push` write both, under the `sync/` lock.
 * It is a file of its own so that a `last.json` an older pi-profile reads
 * keeps its shape.
 */

export interface HubPin {
	readonly pin?: string;
	readonly agreed?: string;
}

export function pinStatePath(l: Layout): string {
	return join(l.piHome, "pi-profile", "state", "sync", "pin.json");
}

const SHAPE = 'pin.json must be { "schemaVersion": 1, "hubs": { HUB: { "pin"?: PIN, "agreed"?: PIN } } }';

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parsePinState(raw: unknown): Map<string, HubPin> | string {
	if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.hubs) || Object.keys(raw).some((k) => k !== "schemaVersion" && k !== "hubs")) return SHAPE;
	const out = new Map<string, HubPin>();
	for (const [hub, v] of Object.entries(raw.hubs)) {
		if (!isHubName(hub) || !record(v) || Object.keys(v).some((k) => k !== "pin" && k !== "agreed")) return SHAPE;
		if ((v.pin !== undefined && !isPin(v.pin)) || (v.agreed !== undefined && !isPin(v.agreed))) return SHAPE;
		out.set(hub, { ...(v.pin === undefined ? {} : { pin: v.pin }), ...(v.agreed === undefined ? {} : { agreed: v.agreed }) });
	}
	return out;
}

/** Each hub's pin here; empty when there is no file. A broken file is refused, never guessed at. */
export function readPinState(l: Layout): Map<string, HubPin> {
	const path = pinStatePath(l);
	let raw: unknown;
	try {
		raw = readJson(path);
	} catch (error) {
		throw new Refusal(`${printable(path)}: ${(error as NodeJS.ErrnoException).code ?? "not valid JSON"}; set the pin again with pi-profile pin VERSION, after removing the file`);
	}
	if (raw === undefined) return new Map();
	const s = parsePinState(raw);
	if (typeof s === "string") throw new Refusal(`${printable(path)}: ${s}; set the pin again with pi-profile pin VERSION, after removing the file`);
	return s;
}

export function writePinState(l: Layout, pins: ReadonlyMap<string, HubPin>): void {
	const path = pinStatePath(l);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const hubs = [...pins]
		.filter(([, p]) => p.pin !== undefined || p.agreed !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([hub, p]) => [hub, { ...(p.pin === undefined ? {} : { pin: p.pin }), ...(p.agreed === undefined ? {} : { agreed: p.agreed }) }] as const);
	writeJsonAtomic(path, { schemaVersion: 1, hubs: Object.fromEntries(hubs) });
}

/** This host set a pin (or cleared one) that the hub does not hold yet. */
export function pinPending(p: HubPin | undefined): boolean {
	return p !== undefined && p.pin !== p.agreed;
}

/**
 * This host's pin waits to be pushed, and the hub's pin `hubPin` moved since
 * this host last agreed with it, to another value: both sides changed it
 * (issue 54). `sync pull` refuses it, as it refuses a file changed
 * on both sides, and `sync push` refuses to replace the hub's pin unseen.
 */
export function pinDiverged(p: HubPin | undefined, hubPin: string | undefined): boolean {
	return pinPending(p) && hubPin !== p?.agreed && hubPin !== p?.pin;
}

/** `none` for no pin; a pin printed safely. */
export function shownPin(pin: string | undefined): string {
	return pin === undefined ? "none" : printable(pin);
}
