# pi-daemon

`pi-daemon` is a library and command-line application for running headless pi agent sessions in-process through the pi SDK. Clients can attach over a local Unix socket, replay durable history from a cursor, follow live output, and drive sessions under an explicit arbitration contract. The daemon keeps pi session JSONL as the durable source of truth and records its own state transitions as custom entries.

## Install

Requires Node.js 24 or later.

```sh
npm install @centerforagenticai/pi-daemon
```

The package exports its main API, a client API at `@centerforagenticai/pi-daemon/client`, and protocol types and validators at `@centerforagenticai/pi-daemon/protocol`. The `pi-daemon` command is also installed as a package executable.

## Development

```sh
npm ci && npm run ci
```
