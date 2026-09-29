#!/usr/bin/env node

import assert from "node:assert/strict";

const [daemon, client, protocol] = await Promise.all([
  import("../dist/index.js"),
  import("../dist/client/index.js"),
  import("../dist/protocol/index.js"),
]);

assert.equal(typeof daemon.runDaemon, "function");
assert.equal(typeof client.connectDaemon, "function");
assert.equal(protocol.PROTOCOL_VERSION, "1.0");
assert.equal(protocol.isProtocolFrame({ t: "req", id: "smoke", op: "list", params: {} }), true);

console.log("public release smoke: pass");
