/**
 * Live agent context across Pi SDK generations.
 *
 * Pi 0.80–0.85 sent `agent.state.messages` to the provider, so pruning or
 * seeding that array changed what the model saw. From Pi 0.86 the session
 * rebuilds the provider context from the session branch before every request
 * (`buildSessionProjection()`), and a direct `agent.state.messages` assignment
 * is silently overwritten. These helpers write through the session branch when
 * the session projects its context, and keep the old assignment otherwise.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type LiveMessage = AgentSession["messages"][number];

interface ProjectedEntry {
	readonly sourceEntry: { readonly id: string };
	readonly messages: readonly LiveMessage[];
}

interface ProjectingSessionManager {
	buildSessionProjection(): { readonly entries: readonly ProjectedEntry[]; readonly messages: readonly LiveMessage[] };
	appendMessage(message: LiveMessage): string;
	appendContextEdit(targetId: string, replacement: null): string;
}

interface ProjectingSession {
	readonly sessionManager: ProjectingSessionManager;
	refreshContext(): void;
}

function projectingSession(session: AgentSession): ProjectingSession | undefined {
	const candidate = session as unknown as Partial<ProjectingSession>;
	const manager = candidate.sessionManager as Partial<ProjectingSessionManager> | undefined;
	if (
		typeof candidate.refreshContext !== "function" ||
		typeof manager?.buildSessionProjection !== "function" ||
		typeof manager.appendMessage !== "function" ||
		typeof manager.appendContextEdit !== "function"
	) {
		return undefined;
	}
	return candidate as ProjectingSession;
}

/**
 * Install prior history on a fresh session so the first provider request sees it.
 * On projecting SDKs each message becomes a session entry; otherwise the live
 * array is replaced as before.
 */
export function seedLiveContext(session: AgentSession, messages: readonly LiveMessage[]): void {
	if (messages.length === 0) return;
	const projecting = projectingSession(session);
	if (!projecting) {
		session.agent.state.messages = [...messages];
		return;
	}
	for (const message of messages) projecting.sessionManager.appendMessage(message);
	projecting.refreshContext();
}

function entryIdFor(projection: ReturnType<ProjectingSessionManager["buildSessionProjection"]>, target: LiveMessage): string | undefined {
	for (let index = projection.entries.length - 1; index >= 0; index -= 1) {
		const entry = projection.entries[index]!;
		if (entry.messages.includes(target)) return entry.sourceEntry.id;
	}
	return undefined;
}

/**
 * Remove the trailing assistant from live provider context while keeping it in
 * the session history. Returns false when the live context does not end with an
 * assistant or when the SDK cannot attribute it to a session entry.
 */
export function dropTrailingLiveAssistant(session: AgentSession): boolean {
	const messages = session.agent.state.messages as readonly LiveMessage[];
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return false;
	const projecting = projectingSession(session);
	if (!projecting) {
		session.agent.state.messages = messages.slice(0, -1);
		return true;
	}
	const projection = projecting.sessionManager.buildSessionProjection();
	const entryId = entryIdFor(projection, last);
	if (entryId === undefined) return false;
	projecting.sessionManager.appendContextEdit(entryId, null);
	projecting.refreshContext();
	const after = session.agent.state.messages as readonly LiveMessage[];
	return !after.includes(last);
}

/**
 * Pi >= 0.86 appends `role: "system"` messages (the system prompt and tool
 * declaration deltas) to the transcript and emits `message_end` for them.
 * They are not worker activity: counting them as progress events spends the
 * bounded event-bus budget on bookkeeping and can coalesce away real updates.
 */
export function isPiSystemMessage(message: unknown): boolean {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}
