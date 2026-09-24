/**
 * Thin project-owned re-export of the host `fuzzyMatch` matcher.
 *
 * The completion policy imports `fuzzyMatch` through this module rather than
 * directly from `@earendil-works/pi-tui` for one reason: the pi-tui namespace
 * export is non-configurable and its module namespace is frozen, so a test
 * cannot spy the matcher at the pi-tui boundary. Routing the single logical
 * haystack call through this project module lets `M-COMP-FUZZY-ID` inspect the
 * exact matcher argument — the only way to prove the standalone bare-id
 * haystack field survives, because a bare id is always a subsequence of both
 * prefixed fields and so cannot be distinguished by a match/no-match query.
 *
 * This module adds no behavior; it re-exports the host matcher unchanged.
 */
export { fuzzyMatch } from "@earendil-works/pi-tui";
