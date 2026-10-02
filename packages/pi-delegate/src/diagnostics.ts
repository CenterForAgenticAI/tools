/** Runtime entry: registers the SDK default agent directory for diagnostics and config. */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerDefaultAgentDir } from "./diagnostics-file.js";
export * from "./diagnostics-file.js";

registerDefaultAgentDir(getAgentDir);
