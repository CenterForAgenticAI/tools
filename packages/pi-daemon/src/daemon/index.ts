export {
  DAEMON_VERSION,
  GATE_MODEL_RUNTIME_MODULE_ENV,
  DaemonAlreadyRunningError,
  DaemonStartupError,
  GateModelRuntimeStartupError,
  runDaemon,
  type DaemonTermination,
  type GateModelRuntimeFactory,
  type GateModelRuntimeFactoryResult,
  type RunDaemonOptions,
  type RunningDaemon,
} from "./bootstrap.js";
export type { DiagnosticLogSink } from "../logging/index.js";

export {
  createDaemonDispatch,
  type DaemonDispatchOptions,
  type DaemonDispatchRuntime,
  type DaemonShutdownRequest,
} from "./dispatch.js";
