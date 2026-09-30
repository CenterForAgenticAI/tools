import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskTool } from "./tools/ask.ts";

export default function piQuestion(pi: ExtensionAPI): void {
	pi.registerTool(createAskTool(pi));
}
