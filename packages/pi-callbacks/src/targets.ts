import type { CallbackJob, DeliveryEvent, DeliveryTarget, SessionPresence, SessionRef } from "./types.ts";

export const DELIVERY_TARGET_NAMES = ["origin", "latest-active", "latest-active-cwd", "session", "desktop"] as const;

export function parseDeliveryTarget(kind: string | undefined, session?: string): DeliveryTarget | undefined {
  if (kind === undefined) return undefined;
  switch (kind.trim()) {
    case "origin": return { kind: "origin" };
    case "latest-active": return { kind: "latest-active" };
    case "latest-active-cwd": return { kind: "latest-active-cwd" };
    case "desktop": return { kind: "desktop" };
    case "session": {
      const value = session?.trim();
      if (!value) throw new Error("target=session requires targetSession");
      return { kind: "session", session: value };
    }
    default: throw new Error(`Unknown callback target: ${kind}`);
  }
}

export function effectiveJobOrigin(job: CallbackJob): SessionRef | undefined {
  if (job.origin) return job.origin;
  if (!job.sessionFile && !job.cwd) return undefined;
  const sessionFile = job.sessionFile;
  return {
    sessionId: sessionFile ?? `legacy-cwd:${job.cwd}`,
    ...(sessionFile === undefined ? {} : { sessionFile }),
    cwd: job.cwd ?? "",
  };
}

export function effectiveJobTarget(job: CallbackJob): DeliveryTarget {
  return job.target ?? { kind: "origin" };
}

export function effectiveEventOrigin(event: DeliveryEvent): SessionRef | undefined {
  return event.origin ?? effectiveJobOrigin(event.jobSnapshot);
}

export function effectiveEventTarget(event: DeliveryEvent): DeliveryTarget {
  return event.target ?? effectiveJobTarget(event.jobSnapshot);
}

export function sessionMatchesRef(presence: SessionPresence | SessionRef, ref: SessionRef): boolean {
  return presence.sessionId === ref.sessionId
    || Boolean(presence.sessionFile && ref.sessionFile && presence.sessionFile === ref.sessionFile);
}

export function sessionMatchesSelector(presence: SessionPresence | SessionRef, selector: string): boolean {
  return presence.sessionId === selector || presence.sessionFile === selector;
}

export function selectTargetPresence(
  event: DeliveryEvent,
  sessions: SessionPresence[],
): SessionPresence | undefined {
  const target = effectiveEventTarget(event);
  const origin = effectiveEventOrigin(event);
  switch (target.kind) {
    case "desktop": return undefined;
    case "origin": return origin ? newestPresence(sessions.filter((session) => sessionMatchesRef(session, origin))) : undefined;
    case "session": return newestPresence(sessions.filter((session) => sessionMatchesSelector(session, target.session)));
    case "latest-active": return newestPresence(sessions);
    case "latest-active-cwd": return origin
      ? newestPresence(sessions.filter((session) => session.cwd === origin.cwd))
      : undefined;
  }
}

export function describeDeliveryTarget(target: DeliveryTarget): string {
  return target.kind === "session" ? `session:${target.session}` : target.kind;
}

function newestPresence(sessions: SessionPresence[]): SessionPresence | undefined {
  return sessions.reduce<SessionPresence | undefined>((latest, session) => {
    if (!latest) return session;
    if (session.lastActiveAt !== latest.lastActiveAt) {
      return session.lastActiveAt > latest.lastActiveAt ? session : latest;
    }
    if (session.lastSeenAt !== latest.lastSeenAt) {
      return session.lastSeenAt > latest.lastSeenAt ? session : latest;
    }
    return session.runtimeId.localeCompare(latest.runtimeId) > 0 ? session : latest;
  }, undefined);
}
