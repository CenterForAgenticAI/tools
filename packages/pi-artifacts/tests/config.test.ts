import test from "node:test";
import assert from "node:assert/strict";
import { localBaseUrl, loadConfig, type ArtifactsConfig } from "../src/config.ts";
import { validatePublicBaseUrl } from "../src/public-url.ts";

test("localBaseUrl uses an explicit HTTPS client transport for remote daemons", () => {
  const config: ArtifactsConfig = { host: "daemon.example.com", port: 443, clientScheme: "https" };
  assert.equal(localBaseUrl(config), "https://daemon.example.com:443");
});

test("localBaseUrl remains HTTP for local and legacy configuration", () => {
  assert.equal(localBaseUrl({ host: "127.0.0.1", port: 8787 }), "http://127.0.0.1:8787");
});

test("public URL validation is independent of transport configuration", () => {
  assert.equal(validatePublicBaseUrl("https://daemon.example.com:8443/artifacts/"), "https://daemon.example.com:8443/artifacts/");
  assert.equal(validatePublicBaseUrl("http://127.0.0.1:8787"), null);
  const cfg = loadConfig();
  assert.equal(cfg.host, process.env.PI_ARTIFACTS_HOST || "127.0.0.1");
});
