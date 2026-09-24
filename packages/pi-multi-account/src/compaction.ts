import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/**
 * Current Pi exposes a public pre-compaction event and allows a completed
 * compaction result to be supplied, but it does not expose a request-scoped
 * model override. Persistently selecting a model here would affect later turns,
 * so this router deliberately returns no opinion until Pi adds that public
 * boundary.
 */
export class CompactionRouter {
  route(_event: SessionBeforeCompactEvent): undefined {
    return undefined;
  }
}
