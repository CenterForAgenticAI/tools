/** Detached-child extension entrypoint for the worker ask deny shim. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeWorkerAskRoutingTool } from "./worker-ask-routing.js";

export default function (pi: ExtensionAPI): void {
	pi.registerTool(makeWorkerAskRoutingTool({ enabled: false }));
}
