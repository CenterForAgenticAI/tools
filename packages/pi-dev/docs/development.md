# Development reference

For contributors: the full local gate, test isolation rules, and package smoke behavior.

## Development

Node 24 is the workspace baseline. Install and run the canonical gate:

```sh
npm ci
npm run check
```

`npm run check` runs ESLint, strict TypeScript, an emitting build, a packed install+jiti extension smoke test, and deterministic source-inclusive coverage. Coverage emits text, lcov, and Cobertura reports with blocking regression floors.

Tests use fakes and temporary directories. They do not access the real `~/.pi`, mutate settings, or launch a browser.

The package has no runtime dependencies beyond its Pi peer packages. Package smoke testing packs the package, installs the tarball tokenlessly in a temporary directory, imports the root and `testing` exports, and loads `index.ts` through the same jiti loader Pi uses.
