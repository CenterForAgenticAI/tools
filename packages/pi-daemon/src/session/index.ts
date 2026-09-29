export {
  ColdSessionOperations,
  type ColdSessionOperationsOptions,
} from "./operations.js";
export { SessionLockRegistry } from "./lock-registry.js";
export {
  SessionOperationError,
  type SessionOperationErrorCode,
} from "./errors.js";
export { projectSessionSummary } from "./projection.js";
export {
  acquireSessionFileLock,
  sessionFileLockPath,
  type SessionFileLock,
} from "./sidecar-lock.js";
