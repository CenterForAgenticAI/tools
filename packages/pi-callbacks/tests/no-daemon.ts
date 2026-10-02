import type { PiCallbacksOptions } from "../index.ts";

/**
 * Extension options for tests. Constructing the extension must never probe for
 * or spawn the real daemon: that would bind the shared default port and use the
 * real store.
 */
export const NO_DAEMON: PiCallbacksOptions = { ensureDaemon: () => Promise.resolve("running") };
