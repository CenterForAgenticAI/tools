import { randomUUID } from "node:crypto";

import type { AwakeSessionHost } from "../host/index.js";
import type { CustomEntryData } from "../protocol/index.js";
import {
  RegistryError,
  type LeaseRecord,
  type Registry,
} from "../registry/registry.js";

export interface LeaseArbiterOptions {
  readonly registry: Registry;
  readonly defaultTtlMs: number;
  readonly now?: () => number;
  readonly leaseId?: () => string;
  readonly getAwakeHost?: (
    sessionId: string,
  ) => Pick<AwakeSessionHost, "appendDaemonEntry"> | undefined;
  readonly onLeaseChanged?: (sessionId: string, reason: "lease_changed" | "lease_released" | "lease_expired") => void | Promise<void>;
}

export interface LeaseAcquireInput {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly attachmentId: string;
  readonly actorId: string;
  readonly generation: number;
  readonly ttlMs?: number;
}

export interface LeaseGrant {
  readonly leaseId: string;
  readonly holder: {
    readonly connectionId: string;
    readonly attachmentId: string;
  };
  readonly generation: number;
  readonly expiresAt: string;
  readonly ttlMs: number;
}

export interface LeaseHeartbeatInput {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export interface LeaseHeartbeatResult {
  readonly leaseId: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export interface LeaseReleaseInput {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export interface LeaseReleaseResult {
  readonly released: true;
}

export interface LeaseTakeoverInput extends LeaseAcquireInput {
  readonly reason: string;
}

export interface DriverAuthorityInput {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly nowMs: number;
}

export interface SleepRecoverAuthorityInput {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly leaseId?: string;
  readonly generation: number;
  readonly nowMs: number;
}

export class LeaseArbiter {
  readonly #registry: Registry;
  readonly #defaultTtlMs: number;
  readonly #now: () => number;
  readonly #leaseId: () => string;
  readonly #getAwakeHost: NonNullable<LeaseArbiterOptions["getAwakeHost"]>;
  readonly #onLeaseChanged: NonNullable<LeaseArbiterOptions["onLeaseChanged"]>;

  constructor(options: LeaseArbiterOptions) {
    this.#registry = options.registry;
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#now = options.now ?? Date.now;
    this.#leaseId = options.leaseId ?? randomUUID;
    this.#getAwakeHost = options.getAwakeHost ?? (() => undefined);
    this.#onLeaseChanged = options.onLeaseChanged ?? (() => undefined);
  }

  async acquire(input: LeaseAcquireInput): Promise<LeaseGrant> {
    const nowMs = this.#now();
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    const previous = this.#registry.checkLease({
      sessionId: input.sessionId,
      generation: input.generation,
      nowMs,
    });
    const lease = this.#registry.acquireLease({
      sessionId: input.sessionId,
      leaseId: this.#leaseId(),
      attachmentId: input.attachmentId,
      actorId: input.actorId,
      generation: input.generation,
      expiresAtMs: nowMs + ttlMs,
      ttlMs,
      nowMs,
    });
    const session = this.#registry.getSession(input.sessionId);
    if (session === undefined) {
      throw new Error("session disappeared after lease acquisition");
    }
    if (previous.status === "expired") {
      await this.appendExpired(
        input.sessionId,
        previous.lease,
        input.generation,
        nowMs,
      );
    }
    await this.#onLeaseChanged(input.sessionId, previous.status === "active" ? "lease_changed" : "lease_expired");
    await this.appendTransition(input.sessionId, {
      v: 1,
      action: "acquired",
      leaseId: lease.leaseId,
      actorId: lease.actorId,
      generation: lease.generation,
      epoch: session.epoch,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      at: new Date(nowMs).toISOString(),
    });

    return {
      leaseId: lease.leaseId,
      holder: {
        connectionId: input.connectionId,
        attachmentId: lease.attachmentId,
      },
      generation: lease.generation,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      ttlMs: lease.ttlMs,
    };
  }

  async takeover(input: LeaseTakeoverInput): Promise<LeaseGrant> {
    const nowMs = this.#now();
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    const previous = this.#registry.checkLease({
      sessionId: input.sessionId,
      generation: input.generation,
      nowMs,
    });
    if (previous.status === "expired") {
      await this.appendExpired(
        input.sessionId,
        previous.lease,
        input.generation,
        nowMs,
      );
      throw new RegistryError(
        "lease_expired",
        `driver lease expired for session ${input.sessionId}`,
      );
    }
    if (previous.status === "none") {
      throw new RegistryError(
        "no_lease",
        `no driver lease to take over for session ${input.sessionId}`,
      );
    }
    const result = this.#registry.takeoverLease({
      sessionId: input.sessionId,
      leaseId: this.#leaseId(),
      attachmentId: input.attachmentId,
      actorId: input.actorId,
      generation: input.generation,
      expiresAtMs: nowMs + ttlMs,
      ttlMs,
      nowMs,
    });
    const session = this.#registry.getSession(input.sessionId);
    if (session === undefined) {
      throw new Error("session disappeared after lease takeover");
    }
    await this.#onLeaseChanged(input.sessionId, "lease_changed");
    await this.appendTransition(input.sessionId, {
      v: 1,
      action: "taken_over",
      leaseId: result.lease.leaseId,
      actorId: result.lease.actorId,
      previousLeaseId: result.revokedLeaseId,
      generation: result.lease.generation,
      epoch: session.epoch,
      expiresAt: new Date(result.lease.expiresAtMs).toISOString(),
      at: new Date(nowMs).toISOString(),
    });

    return {
      leaseId: result.lease.leaseId,
      holder: {
        connectionId: input.connectionId,
        attachmentId: result.lease.attachmentId,
      },
      generation: result.lease.generation,
      expiresAt: new Date(result.lease.expiresAtMs).toISOString(),
      ttlMs: result.lease.ttlMs,
    };
  }

  async heartbeat(input: LeaseHeartbeatInput): Promise<LeaseHeartbeatResult> {
    const nowMs = this.#now();
    await this.requireDriverLease(input, nowMs);
    const expiresAtMs = this.#registry.heartbeatLease({
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      attachmentId: input.attachmentId,
      generation: input.generation,
      nowMs,
    });
    return {
      leaseId: input.leaseId,
      generation: input.generation,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async assertDriver(input: DriverAuthorityInput): Promise<void> {
    await this.requireDriverLease(input, input.nowMs);
  }

  async assertSleepRecoverAuthority(
    input: SleepRecoverAuthorityInput,
  ): Promise<void> {
    const checked = this.#registry.checkLease({
      sessionId: input.sessionId,
      generation: input.generation,
      nowMs: input.nowMs,
    });
    if (checked.status === "expired") {
      await this.appendExpired(
        input.sessionId,
        checked.lease,
        input.generation,
        input.nowMs,
      );
      return;
    }
    if (checked.status === "none") {
      return;
    }
    if (
      checked.lease.leaseId !== input.leaseId ||
      checked.lease.attachmentId !== input.attachmentId
    ) {
      throw new RegistryError(
        "no_lease",
        `an active driver lease is held by another attachment for session ${input.sessionId}`,
      );
    }
  }

  async release(input: LeaseReleaseInput): Promise<LeaseReleaseResult> {
    const nowMs = this.#now();
    const lease = await this.requireDriverLease(input, nowMs);
    if (!this.#registry.releaseLease(input.sessionId, input.leaseId)) {
      throw new RegistryError(
        "no_lease",
        `no matching driver lease for session ${input.sessionId}`,
      );
    }
    const session = this.#registry.getSession(input.sessionId);
    if (session === undefined) {
      throw new Error("session disappeared after lease release");
    }
    await this.#onLeaseChanged(input.sessionId, "lease_released");
    await this.appendTransition(input.sessionId, {
      v: 1,
      action: "released",
      leaseId: lease.leaseId,
      actorId: lease.actorId,
      generation: input.generation,
      epoch: session.epoch,
      at: new Date(nowMs).toISOString(),
    });
    return { released: true };
  }

  async releaseByAttachment(
    sessionId: string,
    attachmentId: string,
  ): Promise<boolean> {
    const lease = this.#registry.getLease(sessionId);
    if (lease === undefined || lease.attachmentId !== attachmentId) {
      return false;
    }
    if (!this.#registry.releaseLease(sessionId, lease.leaseId)) {
      return false;
    }
    const session = this.#registry.getSession(sessionId);
    if (session === undefined) {
      throw new Error("session disappeared after disconnect lease release");
    }
    await this.#onLeaseChanged(sessionId, "lease_released");
    await this.appendTransition(sessionId, {
      v: 1,
      action: "disconnected",
      leaseId: lease.leaseId,
      actorId: lease.actorId,
      generation: session.generation,
      epoch: session.epoch,
      at: new Date(this.#now()).toISOString(),
    });
    return true;
  }

  private async requireDriverLease(
    input: LeaseReleaseInput | DriverAuthorityInput,
    nowMs: number,
  ): Promise<LeaseRecord> {
    const checked = this.#registry.checkLease({
      sessionId: input.sessionId,
      generation: input.generation,
      nowMs,
    });
    if (checked.status === "expired") {
      await this.appendExpired(input.sessionId, checked.lease, input.generation, nowMs);
      throw new RegistryError(
        "lease_expired",
        `driver lease expired for session ${input.sessionId}`,
      );
    }
    if (
      checked.status === "none" ||
      checked.lease.leaseId !== input.leaseId ||
      checked.lease.attachmentId !== input.attachmentId
    ) {
      throw new RegistryError(
        "no_lease",
        `no matching driver lease for session ${input.sessionId}`,
      );
    }
    return checked.lease;
  }

  private async appendExpired(
    sessionId: string,
    lease: LeaseRecord,
    generation: number,
    nowMs: number,
  ): Promise<void> {
    const session = this.#registry.getSession(sessionId);
    if (session === undefined) {
      throw new Error("session disappeared after lease expiry");
    }
    await this.#onLeaseChanged(sessionId, "lease_expired");
    await this.appendTransition(sessionId, {
      v: 1,
      action: "expired",
      leaseId: lease.leaseId,
      actorId: lease.actorId,
      generation,
      epoch: session.epoch,
      at: new Date(nowMs).toISOString(),
    });
  }

  private async appendTransition(
    sessionId: string,
    data: CustomEntryData<"pi-daemon/lease">,
  ): Promise<void> {
    const host = this.#getAwakeHost(sessionId);
    if (host !== undefined) {
      await host.appendDaemonEntry("pi-daemon/lease", data);
    }
  }
}
