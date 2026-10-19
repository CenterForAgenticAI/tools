# Development

This directory is a public release snapshot. The canonical source is maintained in a private repository, and maintainers carry accepted pull requests from [CenterForAgenticAI/tools](https://github.com/CenterForAgenticAI/tools) into that source.

From the exported package directory, run:

```sh
bun install
npm test
```

Pi loads the bundled entry `dist/index.js`, built from `src/index.ts`. `bun install` builds it. After a `git pull` in a checkout that Pi loads directly, run `bun install` again and restart Pi; until then Pi runs the old bundle.

The private source repository has additional release gates that are not part of this snapshot.
