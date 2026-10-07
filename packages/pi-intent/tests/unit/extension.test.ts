import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FABRIC_COMPONENT_DISCOVER_EVENT, FABRIC_COMPONENT_REGISTER_EVENT, type FabricComponentDiscovery, type FabricComponentRegistration } from "pi-fabric/protocol";

import piIntent from "../../src/index.js";

function fakePi() {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const handlers = new Map<string, (payload: never) => void>();
	const commands: string[] = [];
	const pi = {
		events: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }), on: (event: string, handler: (payload: never) => void) => { handlers.set(event, handler); return () => handlers.delete(event); } },
		on: () => undefined,
		registerCommand: (name: string) => { commands.push(name); },
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	return { pi, emitted, handlers, commands };
}

test("the extension registers the pi-intent component with Fabric and keeps its command", () => {
	const { pi, emitted, commands } = fakePi();
	piIntent(pi);
	const registration = emitted.find((e) => e.event === FABRIC_COMPONENT_REGISTER_EVENT)?.payload as FabricComponentRegistration;
	assert.equal(registration.version, 1);
	assert.equal(registration.component.name, "pi-intent");
	assert.deepEqual(registration.component.provides, ["intent"]);
	assert.equal(registration.overwrite, true);
	assert.deepEqual(commands, ["intent-prereqs"]);
});

test("the extension answers a Fabric discovery handshake with the same component", () => {
	const { pi, handlers } = fakePi();
	piIntent(pi);
	const seen: string[] = [];
	const discovery: FabricComponentDiscovery = { version: 1, register: (component) => { seen.push(component.name); } };
	(handlers.get(FABRIC_COMPONENT_DISCOVER_EVENT) as (d: FabricComponentDiscovery) => void)(discovery);
	assert.deepEqual(seen, ["pi-intent"]);
});
