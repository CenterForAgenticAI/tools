import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DelegateConfig } from "../config.js";
import { DEFAULT_DELEGATE_ONLY_CONFIG } from "./config.js";
import { setupActivation } from "./activation.js";
import { setupForegroundGating } from "./lifecycle.js";
import { renderDelegateOnlyPromptSection } from "./prompt.js";
import { registerCappedRead } from "./read-wrapper.js";
import {
	createDelegateOnlyRuntime,
	registerActiveDelegateOnlyRuntime,
} from "./runtime-state.js";
import { shouldSkipForegroundLifecycleForDelegateOwnedApi } from "../delegate-session-scope.js";

export interface SetupDelegateOnlyOptions {
	config: DelegateConfig;
	agentDir?: string;
}

export function setupDelegateOnly(pi: ExtensionAPI, options: SetupDelegateOnlyOptions): void {
	const doConfig = options.config.delegateOnly ?? DEFAULT_DELEGATE_ONLY_CONFIG;
	const runtime = createDelegateOnlyRuntime(doConfig, false, "off");
	const isDelegateOwnedChild =
		shouldSkipForegroundLifecycleForDelegateOwnedApi(pi) || process.env.PI_DELEGATE_CHILD === "1";
	if (!isDelegateOwnedChild) registerActiveDelegateOnlyRuntime(runtime);
	registerCappedRead(pi, runtime);
	setupActivation(pi, runtime);
	setupForegroundGating(pi, runtime, { renderPromptSection: renderDelegateOnlyPromptSection });
}
