// The change a stored write makes, as both change indexes record it: the in-memory one in ../feed.ts and the durable
// one in ./store.ts. Not a package export.
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { Change } from "../feed.ts";

export function changeOf(w: StorageWrite): Change {
	switch (w.type) {
		case "conversation":
			return { kind: "conversation", id: w.value.id, op: "insert" };
		case "entry":
			return { kind: "entry", id: w.value.id, op: "insert", conversation: w.value.conversationId };
		case "task":
			return { kind: "task", id: w.value.id, op: w.value.state.status };
		case "submission": {
			const { id, status, conversationId, requestId, type } = w.value;
			const change: Change = { kind: "submission", id, op: status, conversation: conversationId, type };
			if (requestId !== undefined) change.requestId = requestId;
			return change;
		}
		case "document.create":
		case "document.copy":
			return { kind: "document", id: w.record.id, op: w.type.slice(9) };
		case "document.change":
			return { kind: "document", id: w.id, op: w.content.kind };
		case "document.retire":
			return { kind: "document", id: w.id, op: "retire" };
	}
}
