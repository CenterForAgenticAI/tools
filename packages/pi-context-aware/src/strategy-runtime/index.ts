/**
 * The context strategy runtime (pi-context-aware#465): the code that builds a strategy's view from the
 * session. Strategies never import it; src/strategy holds the contract and strategy code only.
 * Internal: no package entry point re-exports it.
 */
export * from "./check-plan.js";
export * from "./context-view.js";
