import { formatNodeAddress } from "../plan/index.js";
import type { StatusBlocker } from "./types.js";

export function renderBlockers(blockers: readonly StatusBlocker[]): string {
	return blockers.map((blocker) => {
		switch (blocker.code) {
			case "dependency": return `dependency ${blocker.addresses.map(formatNodeAddress).join(", ")}`;
			case "children": return `children ${blocker.addresses.map(formatNodeAddress).join(", ")}`;
			case "completion-contract": return `completion contract ${blocker.reason}`;
			case "open-decision": return `open decisions ${blocker.ids.join(", ")}`;
		}
	}).join("; ");
}
