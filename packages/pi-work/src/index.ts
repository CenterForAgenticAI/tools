import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { workDecomposeCommand } from "./commands/work-decompose.js";
import { workDraftCommand } from "./commands/work-draft.js";
import { workNextCommand } from "./commands/work-next.js";
import { workPromoteCommand } from "./commands/work-promote.js";
import { workStatusCommand } from "./commands/work-status.js";
import { workAmendCriterionTool } from "./tools/work-amend-criterion.js";
import { workDispatchTool } from "./tools/work-dispatch.js";
import { workPlanTool } from "./tools/work-plan.js";
import { workPromoteTool } from "./tools/work-promote.js";
import { workStatusTool } from "./tools/work-status.js";
import { workValidateTool } from "./tools/work-validate.js";
import { workVerifyTool } from "./tools/work-verify.js";

/** Register pi-work's complete v1 surface. */
export default function piWork(pi: ExtensionAPI): void {
	pi.registerTool(workValidateTool);
	pi.registerTool(workPromoteTool);
	pi.registerTool(workAmendCriterionTool);
	pi.registerTool(workStatusTool);
	pi.registerTool(workPlanTool);
	pi.registerTool(workDispatchTool);
	pi.registerTool(workVerifyTool);

	pi.registerCommand("work-draft", workDraftCommand(pi));
	pi.registerCommand("work-promote", workPromoteCommand(pi));
	pi.registerCommand("work-decompose", workDecomposeCommand(pi));
	pi.registerCommand("work-status", workStatusCommand(pi));
	pi.registerCommand("work-next", workNextCommand(pi));
}
