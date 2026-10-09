import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerFabricWorkProvider } from "./fabric-provider.js";

import { workDecomposeCommand } from "./commands/work-decompose.js";
import { workDraftCommand } from "./commands/work-draft.js";
import { workNextCommand } from "./commands/work-next.js";
import { workPromoteCommand } from "./commands/work-promote.js";
import { workStatusCommand } from "./commands/work-status.js";
import { workAmendCriterionTool } from "./tools/work-amend-criterion.js";
import { createWorkDispatchTool } from "./tools/work-dispatch.js";
import { createFabricDispatchBackend } from "./dispatch/fabric/index.js";
import type { DispatchDependencies } from "./dispatch/index.js";
import { fabricAvailable } from "./dispatch/fabric/availability.js";
import { createFabricCompletionAnnouncements } from "./dispatch/fabric/completion.js";
import { workPlanTool } from "./tools/work-plan.js";
import { workPromoteTool } from "./tools/work-promote.js";
import { workStatusTool } from "./tools/work-status.js";
import { workValidateTool } from "./tools/work-validate.js";
import { workVerifyTool } from "./tools/work-verify.js";

/** Register pi-work's complete v1 surface. */
export default function piWork(pi: ExtensionAPI): void {
	const completion = createFabricCompletionAnnouncements();
	const host = pi.events === undefined ? undefined : createFabricDispatchBackend({ events: pi.events, completion });
	// Resolve at dispatch time: later-loaded extensions can register Fabric.
	const dependencies: DispatchDependencies = {};
	Object.defineProperty(dependencies, "fabricHost", { enumerable: true, get: () => fabricAvailable(pi) ? host : undefined });
	pi.on?.("context", (event) => completion.context(event));
	pi.on?.("session_start", () => completion.clear());
	pi.registerTool(workValidateTool);
	pi.registerTool(workPromoteTool);
	pi.registerTool(workAmendCriterionTool);
	pi.registerTool(workStatusTool);
	pi.registerTool(workPlanTool);
	pi.registerTool(createWorkDispatchTool(dependencies));
	pi.registerTool(workVerifyTool);

	registerFabricWorkProvider(pi, dependencies);

	pi.registerCommand("work-draft", workDraftCommand(pi));
	pi.registerCommand("work-promote", workPromoteCommand(pi));
	pi.registerCommand("work-decompose", workDecomposeCommand(pi));
	pi.registerCommand("work-status", workStatusCommand(pi));
	pi.registerCommand("work-next", workNextCommand(pi));
}
