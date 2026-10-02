import type { Cursor, SessionSummary, StreamFrame } from "../protocol/index.js";

export interface TuiViewModel {
  readonly screen: "connecting" | "empty" | "observing";
  readonly session: SessionSummary | null;
  readonly transcript: readonly string[];
  readonly live: string | null;
  readonly notices: readonly string[];
  readonly committedCursor: Cursor | null;
  readonly seen: ReadonlySet<string>;
}

export const connectingView = (): TuiViewModel => ({
  screen: "connecting", session: null, transcript: [], live: null, notices: [],
  committedCursor: null, seen: new Set(),
});

const cursorKey = (cursor: Cursor): string => `${cursor.epoch}:${cursor.entryId ?? ""}`;

/** Presentation projection only. Never treats an event, gap or control frame as committed history. */
export function reduceFrame(view: TuiViewModel, frame: StreamFrame): TuiViewModel {
  if (view.screen !== "observing" || frame.session !== view.session?.sessionId) return view;
  if (frame.generation !== view.session.generation) {
    const notice = `Stale generation: frame ${frame.generation}, attached ${view.session.generation}; output not shown.`;
    return view.notices.includes(notice) ? view : { ...view, notices: [...view.notices, notice] };
  }
  if (frame.kind === "entry") {
    const key = cursorKey(frame.cursor);
    if (view.seen.has(key)) return view;
    const seen = new Set(view.seen);
    seen.add(key);
    const line = entryText(frame.entry);
    return {
      ...view, seen, committedCursor: { entryId: frame.cursor.entryId, epoch: frame.cursor.epoch },
      transcript: line === null ? view.transcript : [...view.transcript, line], live: null,
    };
  }
  if (frame.kind === "gap") {
    return { ...view, live: null, notices: [...view.notices,
      `Live output lost (${frame.reason}, sequence ${frame.lost.fromSeq}–${frame.lost.toSeq}); committed replay resumes from ${frame.resumeFrom.entryId ?? "start"}.`] };
  }
  if (frame.kind === "error") {
    return { ...view, live: null, notices: [...view.notices, `Stream ${frame.fatal ? "closed" : "error"}: ${frame.error.code}: ${frame.error.message}`] };
  }
  if (frame.kind === "event" && frame.eventType === "message_update") {
    const event = frame.data.assistantMessageEvent;
    if (event.type === "text_delta" && typeof event.delta === "string") {
      return { ...view, live: (view.live ?? "") + event.delta };
    }
  }
  if (frame.kind === "daemon") {
    if (frame.name === "replay_start" || frame.name === "replay_end") {
      return frame.data.outcome === "cursor_off_branch"
        ? { ...view, notices: [...view.notices, "Cursor off branch: replay starts at the fork point; prior branch output is not continuous."] }
        : view;
    }
    if (frame.name === "keepalive") {
      return { ...view, session: view.session === null ? null : {
        ...view.session, observedPhase: frame.data.observedPhase, attention: frame.data.attention,
      } };
    }
    if (frame.name === "external_writer") {
      return { ...view, notices: [...view.notices, "Session failed: external writer; history may be discontinuous."] };
    }
  }
  return view;
}

function entryText(entry: Record<string, unknown>): string | null {
  if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return null;
  const message = entry.message as Record<string, unknown>;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("\n") : "";
  return text === "" ? null : `${role}: ${safeText(text)}`;
}

export function chooseFocus(sessions: readonly SessionSummary[], savedId: string | null): SessionSummary | null {
  const saved = sessions.find((session) => session.sessionId === savedId);
  if (saved !== undefined) return saved;
  return [...sessions].sort((a, b) =>
    Number(b.attention !== "none") - Number(a.attention !== "none"))[0] ?? null;
}

export function observingView(session: SessionSummary): TuiViewModel {
  return { ...connectingView(), screen: "observing", session };
}

// Daemon history and session names are data, not terminal control instructions.
const safeText = (value: string): string => [...value].map((char) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 32 || (code >= 127 && code <= 159) ? (char === "\n" ? "\n" : " ") : char;
}).join("");

export function viewLines(view: TuiViewModel): { header: string; transcript: string; footer: string } {
  if (view.screen === "connecting") return {
    header: "pi-daemon — Connecting", transcript: "Connecting to daemon (auto-spawn if needed)…", footer: "q / Ctrl+C / Ctrl+D: quit",
  };
  if (view.screen === "empty") return {
    header: "pi-daemon — Empty", transcript: "No sessions. Create one with pi-daemon's client API (create is not yet available in this TUI), or quit (q).",
    footer: "q / Ctrl+C / Ctrl+D: quit",
  };
  const session = view.session;
  if (session === null) throw new Error("observing view requires a session");
  return {
    header: `pi-daemon — ${safeText(session.name ?? session.sessionId)} | ${session.observedPhase} | attention: ${session.attention} | generation ${session.generation} / epoch ${session.epoch}`,
    transcript: [...view.transcript, ...view.notices.map((note) => `[${safeText(note)}]`),
      ...(view.live === null ? [] : [`[live, best effort] ${safeText(view.live)}`])].join("\n\n") || "(No committed messages yet)",
    footer: `Observing only — editor disabled: no driver lease acquired. Cursor: ${safeText(view.committedCursor?.entryId ?? "start")}. q / Ctrl+C / Ctrl+D: quit`,
  };
}
