# Fold kernel verification coverage

This supplements `kernel/PROVENANCE.md` without changing the copied engine.
The copy is acp-kernel 0.0.98 at the commit recorded there.

`scripts/sync-acp-kernel.mjs` checks 55 of the 60 reachable modules byte for
byte against the published tarball's embedded source-map content. These five
modules have no embedded source-map entry. That does not mean they have no
compiled output.

| Module under `kernel/` | Coverage outside source maps |
| --- | --- |
| `index.ts` | Root re-exports are copied from the pinned source commit. Reachability follows their targets, and the adapter imports are type-checked. |
| `types.ts` | Type-only definitions are copied from the pinned commit and checked by TypeScript with the adapter and engine. |
| `search.ts` | Re-exports are copied from the pinned commit. Reachability includes `search/index.ts`, `search/types.ts` and `search/registry.ts`, whose content is source-map checked. |
| `filter/index.ts` | Re-exports are copied from the pinned commit. Reachability includes the registry and apply implementation, whose content is source-map checked. |
| `filter/types.ts` | Type-only filter contracts are copied from the pinned commit and checked by TypeScript with their consumers. |

These checks do not prove tarball equivalence for the five unmapped modules.
The sync does not compare their declarations with the shipped `.d.ts` files.
Their provenance is the pinned upstream commit, not a source-map match.
`npm run check` builds and type-checks the complete copy and runs the adapter,
import and boundary-runtime tests. A future sync must review any change to the
unmapped modules as well as the recorded source-map count.
