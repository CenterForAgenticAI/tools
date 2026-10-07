import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FABRIC_COMPONENT_DISCOVER_EVENT, FABRIC_COMPONENT_REGISTER_EVENT, type FabricComponentDiscovery } from "pi-fabric/protocol";

import { INTENT_COMPONENT } from "./provider.js";
import { missingPrerequisites, prerequisiteNotice } from "./prerequisites.js";

/** Register pi-intent: the intent component with pi-fabric, the prerequisite check and its command. */
export default function piIntent(pi: ExtensionAPI): void {
	// Fabric mounts the component when an instance is configured (see README); both paths hand over the same definition.
	pi.events.emit(FABRIC_COMPONENT_REGISTER_EVENT, { version: 1, component: INTENT_COMPONENT, overwrite: true });
	pi.events.on(FABRIC_COMPONENT_DISCOVER_EVENT, (data) => (data as FabricComponentDiscovery).register(INTENT_COMPONENT, { overwrite: true }));

	const check = (): string | undefined =>
		prerequisiteNotice(missingPrerequisites(pi.getAllTools().map((tool) => ({ source: tool.sourceInfo.source, baseDir: tool.sourceInfo.baseDir }))));

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;
		const notice = check();
		if (notice && ctx.hasUI) ctx.ui.notify(notice, "warning");
	});

	pi.registerCommand("intent-prereqs", {
		description: "Check the packages and executables pi-intent needs",
		handler: async (_args, ctx) => {
			ctx.ui.notify(check() ?? "pi-intent: every prerequisite is installed.", "info");
		},
	});
}
