export {
  canonicalizeSessionFilePath,
  resolveDaemonPaths,
  type DaemonPaths,
  type ResolveDaemonPathsOptions,
} from "./paths.js";
export {
  acquireSingletonLock,
  ensurePrivateStateDirectory,
  type SingletonLock,
  type SingletonLockRecord,
} from "./singleton-lock.js";
export { REGISTRY_SCHEMA_VERSION } from "./migrations.js";
export {
  REGISTRY_META_KEYS,
  Registry,
  RegistryError,
  type AcquireLeaseInput,
  type LeaseRecord,
  type OpenRegistryOptions,
  type PromptIndexRecord,
  type RebindSessionReservationInput,
  type RebuildRegistryResult,
  type RegistryErrorCode,
  type RegistryMetaKey,
  type RegistryMetaValues,
  type RegistryStartupState,
  type ReserveSessionResult,
  type SessionActivityInput,
  type SessionGenerationTransitionInput,
  type SessionGoneReason,
  type SessionRecord,
  type SessionReservation,
  type SessionStartupFence,
  type SessionStateIndexInput,
} from "./registry.js";
export {
  projectSessionFile,
  projectSessionFileAtLeaf,
  type SessionBranchContinuity,
  type SessionBranchContinuityStatus,
  type SessionFileProjection,
} from "./rebuild.js";
