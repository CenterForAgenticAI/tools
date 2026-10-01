import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { missingPrerequisites, prerequisiteNotice } from "./prerequisites.js";

/** Register pi-intent. */
export default function piIntent(pi: ExtensionAPI): void {
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
