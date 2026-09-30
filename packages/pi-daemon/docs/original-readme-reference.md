# Original README reference

This page is for maintainers auditing the documentation restructure and preserves the original installation and development text.

## Install

Requires Node.js 24 or later.

```sh
npm install @centerforagenticai/pi-daemon
```

The package exports its main API, a client API at `@centerforagenticai/pi-daemon/client`, and protocol types and validators at `@centerforagenticai/pi-daemon/protocol`. The `pi-daemon` command is also installed as a package executable.

## Development

From the exported package directory:

```sh
npm install
node scripts/public-release-smoke.mjs
```
