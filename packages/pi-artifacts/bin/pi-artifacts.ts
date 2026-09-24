#!/usr/bin/env node
// pi-artifacts CLI — manage artifacts and the daemon from any shell.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ArtifactsClient } from "../src/client.ts";
import { loadConfig, HOME, ensureHome, APPLETS_DIR } from "../src/config.ts";
import { TAILSCALE_EXECUTABLES } from "../src/public-url.ts";
import { retrievalFailure } from "../src/retrieval.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "src", "server.ts");
const NODE_TS_FLAGS = ["--experimental-strip-types", "--experimental-sqlite"];
const LABEL = "com.pi.artifacts";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function arg(flags: string[], argv: string[]): string | undefined {
  for (const f of flags) {
    const i = argv.indexOf(f);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  }
  return undefined;
}
function has(flag: string, argv: string[]): boolean { return argv.includes(flag); }

function gitRoot(cwd: string): string | null {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return null; }
}
function defaultProject(cwd: string): { project: string; projectPath: string } {
  const root = gitRoot(cwd) || cwd;
  return { project: path.basename(root), projectPath: root };
}

function findTailscale(): string | null {
  for (const c of TAILSCALE_EXECUTABLES) {
    try { execFileSync(c, ["version"], { stdio: "ignore" }); return c; } catch { /* next */ }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const client = new ArtifactsClient();

  switch (cmd) {
    case "serve": {
      // exec the daemon in the foreground
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, [...NODE_TS_FLAGS, SERVER], { stdio: "inherit" });
      child.on("exit", (c) => process.exit(c ?? 0));
      return;
    }

    case "status": {
      const h = await client.health();
      if (!h) { console.log("daemon: DOWN  (" + client.base + ")"); process.exit(1); }
      console.log("daemon: UP");
      console.log("transport: " + client.base + " (diagnostic only)");
      try { console.log("public: " + await client.publicUrl()); }
      catch (error) { console.log("public: unavailable — " + (error instanceof Error ? error.message : String(error))); }
      console.log("store:  " + HOME);
      return;
    }

    case "url": {
      console.log(await client.publicUrl());
      return;
    }

    case "get": {
      const id = argv[1];
      if (!id || id.startsWith("-")) dieRetrieval("INVALID_ARTIFACT_ID", "artifact snapshot failed: artifact id is required");
      let version: number | undefined;
      let output: string | undefined;
      for (let i = 2; i < argv.length; i++) {
        const option = argv[i];
        if (option === "--version") {
          const value = argv[++i];
          if (!value || !/^\d+$/.test(value)) dieRetrieval("INVALID_VERSION", "artifact snapshot failed: version must be a positive integer");
          version = Number(value);
          if (!Number.isSafeInteger(version) || version <= 0) dieRetrieval("INVALID_VERSION", "artifact snapshot failed: version must be a positive integer");
        } else if (option === "--output") {
          output = argv[++i];
          if (!output?.trim()) dieRetrieval("OUTPUT_ERROR", "artifact snapshot failed: output path is empty");
        } else {
          dieRetrieval("INVALID_DAEMON_RESPONSE", `artifact snapshot failed: unknown option ${option}`);
        }
      }
      const controller = new AbortController();
      let interrupted = false;
      const interrupt = () => { interrupted = true; controller.abort(); };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        const result = await client.getSnapshot(id, { version, output: output ? path.resolve(process.cwd(), output) : undefined, signal: controller.signal });
        console.log(JSON.stringify(result));
      } catch (error) {
        const failure = interrupted ? { ok: false, error: { code: "INTERRUPTED", message: "artifact snapshot retrieval interrupted" } } : retrievalFailure(error);
        console.error(JSON.stringify(failure));
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
      return;
    }

    case "add": case "register": {
      const file = argv[1];
      if (!file || file.startsWith("-")) die("usage: pi-artifacts add|register <file> [--project P] [--title T] [--mime T] [--stored] [--tags a,b] [--note N] [--slug S]");
      if (!fs.existsSync(file)) die("no such file: " + file);
      if (!(await client.isUp())) die("daemon is down — run `pi-artifacts install` or `pi-artifacts serve`");
      const dp = defaultProject(process.cwd());
      const mode = has("--stored", argv) ? "stored" : "referenced";
      const tags = arg(["--tags"], argv)?.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await client.addFile(file, {
        project: arg(["--project", "-p"], argv) || dp.project,
        projectPath: dp.projectPath,
        title: arg(["--title", "-t"], argv),
        mime: arg(["--mime"], argv) || null,
        mode,
        tags,
        note: arg(["--note", "-n"], argv) || null,
        slug: arg(["--slug"], argv) || null,
      });
      console.log(`${res.created ? "added" : res.newVersion ? "new version" : "unchanged"}: ${res.url}`);
      return;
    }

    case "publish": {
      const target = argv[1];
      if (!target || target.startsWith("-")) die("usage: pi-artifacts publish <artifact-id|html-or-markdown-file> [--name N]");
      if (!(await client.isUp())) die("daemon is down — run `pi-artifacts install` or `pi-artifacts serve`");
      let artifactId = target;
      let artifactUrl: string | undefined;
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile()) die("publish accepts a registered artifact id or one HTML/Markdown file; register static directories separately when directory artifacts are supported");
        const dp = defaultProject(process.cwd());
        const registered = await client.addFile(target, {
          project: arg(["--project", "-p"], argv) || dp.project,
          projectPath: dp.projectPath,
          title: arg(["--title", "-t"], argv),
          mode: has("--stored", argv) ? "stored" : "referenced",
        });
        artifactId = registered.id;
        artifactUrl = registered.url;
      }
      const published = await client.publishToPreviewShip(artifactId, {
        projectName: arg(["--name", "-n"], argv),
      });
      if (has("--json", argv)) {
        console.log(JSON.stringify({ ...published, artifactUrl: artifactUrl || await client.viewerUrl(artifactId) }, null, 2));
      } else {
        console.log("published: " + published.previewUrl);
        console.log("artifact: " + (artifactUrl || await client.viewerUrl(artifactId)));
        console.log(`deployment: ${published.deploymentId} (${published.projectName})`);
      }
      return;
    }

    case "list": case "ls": {
      if (!(await client.isUp())) die("daemon is down");
      const items = await client.list({
        project: arg(["--project", "-p"], argv),
        q: arg(["--q", "--search"], argv),
        sort: arg(["--sort"], argv),
      });
      if (!items.length) { console.log("(no artifacts)"); return; }
      for (const a of items) {
        const v = a.version_count > 1 ? ` v${a.version_count}` : "";
        console.log(`${a.id}  ${pad(a.kind, 8)} ${pad(a.project, 18)} ${a.title}${v}`);
      }
      return;
    }

    case "applets": {
      if (!(await client.isUp())) die("daemon is down");
      const apps = await client.applets();
      if (!apps.length) { console.log(`(no applets)\nCreate one with: pi-artifacts applet-init <id>`); return; }
      for (const app of apps) {
        console.log(`${pad(app.id, 18)} ${app.title}  ${app.url}`);
        if (app.description) console.log(`  ${app.description}`);
      }
      return;
    }

    case "applet-init": {
      const id = need(argv[1], "usage: pi-artifacts applet-init <id> [--title T]");
      const title = arg(["--title", "-t"], argv) || titleFromId(id);
      const dir = scaffoldApplet(id, title);
      console.log("created applet: " + dir);
      console.log("run `pi-artifacts serve`, then use the daemon URL from `pi-artifacts url` to open /applets/" + id + "/");
      return;
    }

    case "repair-types": {
      if (!(await client.isUp())) die("daemon is down");
      const apply = has("--apply", argv);
      const dryRun = has("--dry-run", argv) || !apply;
      const idsArg = arg(["--ids"], argv);
      const ids = idsArg ? idsArg.split(",").map((s) => s.trim()).filter(Boolean) : argv.slice(1).filter((a) => !a.startsWith("--"));
      const results = await client.repairTypes({ apply, ids: ids.length ? ids : undefined });
      const changed = results.filter((r) => r.changed);
      if (!changed.length) {
        console.log("repair-types: no mismatched artifact type metadata found");
        return;
      }
      for (const r of changed) {
        const status = apply ? "repaired" : dryRun ? "would repair" : "would repair";
        console.log(`${status} ${r.id}  ${r.before.kind}/${r.before.mime || "null"} (v:${r.before.versionMime || "null"}) -> ${r.after.kind}/${r.after.mime} (v:${r.after.versionMime})  ${r.title}`);
      }
      if (!apply) console.log(`\nDry run only. Re-run with --apply to update ${changed.length} artifact(s).`);
      return;
    }

    case "open": {
      const id = argv[1];
      const url = id ? await client.viewerUrl(id) : await client.publicUrl();
      console.log(url);
      try { spawnSync("open", [url]); } catch { /* not mac / headless */ }
      return;
    }

    case "rm": case "delete": {
      const id = need(argv[1], "usage: pi-artifacts rm <id>");
      console.log((await client.action(id, "delete")) ? "deleted " + id : "not found");
      return;
    }
    case "archive": {
      const id = need(argv[1], "usage: pi-artifacts archive <id>");
      console.log((await client.action(id, "archive")) ? "archived " + id : "not found");
      return;
    }
    case "restore": {
      const id = need(argv[1], "usage: pi-artifacts restore <id>");
      console.log((await client.action(id, "restore")) ? "restored " + id : "not found");
      return;
    }
    case "tag": {
      const id = need(argv[1], "usage: pi-artifacts tag <id> a,b,c");
      const tags = need(argv[2], "provide comma-separated tags").split(",").map((s) => s.trim()).filter(Boolean);
      console.log((await client.tag(id, tags)) ? "tagged " + id : "not found");
      return;
    }

    case "install": {
      installLaunchd();
      console.log("waiting for daemon…");
      await sleep(1200);
      const up = await new ArtifactsClient().isUp();
      console.log(up ? "daemon: UP" : "daemon not responding yet (check logs at " + path.join(HOME, "daemon.log") + ")");
      if (!has("--no-tailscale", argv)) await setupTailscale();
      try { console.log("\nDone. Explorer: " + await new ArtifactsClient().publicUrl()); } catch (error) { console.log("\nDone. Public URL unavailable — " + (error instanceof Error ? error.message : String(error))); }
      return;
    }
    case "uninstall": {
      try { spawnSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, PLIST], { stdio: "ignore" }); } catch { /* launchctl may be unavailable or service may be absent */ }
      try { spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" }); } catch { /* fallback unload is best-effort */ }
      if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
      console.log("removed launchd service. (tailscale serve untouched — run `pi-artifacts tailscale-off` to reset)");
      return;
    }
    case "tailscale": { await setupTailscale(); return; }
    case "tailscale-off": {
      const ts = findTailscale();
      if (ts) spawnSync(ts, ["serve", "reset"], { stdio: "inherit" });
      return;
    }

    case "gc": { await gc(); return; }

    default:
      console.log(`pi-artifacts — manage pi agent artifacts

  serve                 run the daemon in the foreground
  install [--no-tailscale]  install launchd service + tailscale serve
  uninstall             remove launchd service
  status                show daemon status + URLs
  url                   print the public base URL
  add <file> [opts]     register a file (default: referenced)
  register <file>       alias for add
  get <id> [opts]       retrieve an immutable snapshot as JSON
       --version N, --output PATH
       --project/-p, --title/-t, --mime T, --stored, --tags a,b, --note/-n, --slug
  publish <id|file>      publish registered HTML/Markdown snapshot through PreviewShip
       --name/-n stable PreviewShip project name, --stored, --project/-p, --json
  list [--project P] [--q text] [--sort modified|created|project|title]
  open [id]             print + open the explorer (or an artifact)
  applets               list registered small applets
  applet-init <id>      scaffold a tiny applet under ${APPLETS_DIR}
  tag <id> a,b,c        set tags
  archive|restore <id>  hide/unhide an artifact
  rm <id>               delete an artifact (blobs pruned via gc)
  repair-types [--dry-run|--apply] [id ...|--ids a,b]
                        repair stored kind/mime when metadata disagrees with bytes
  gc                    prune unreferenced blobs
  tailscale             (re)configure tailscale serve
  tailscale-off         reset tailscale serve

store: ${HOME}`);
      return;
  }
}

function installLaunchd() {
  ensureHome();
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const log = path.join(HOME, "daemon.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    ${NODE_TS_FLAGS.map((flag) => `<string>${flag}</string>`).join("\n    ")}
    <string>${SERVER}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_ARTIFACTS_HOME</key><string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>`;
  fs.writeFileSync(PLIST, plist);
  const uid = process.getuid?.() ?? 0;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST], { stdio: "inherit" });
  if (r.status !== 0) {
    // fallback for older launchctl
    spawnSync("launchctl", ["load", "-w", PLIST], { stdio: "inherit" });
  }
  console.log("installed launchd service: " + PLIST);
}

async function setupTailscale() {
  const ts = findTailscale();
  const cfg = loadConfig();
  if (!ts) { console.log("tailscale CLI not found — skipping. Configure publicBaseUrl or install Tailscale Serve."); return; }
  console.log("configuring `tailscale serve` for port " + cfg.port + " …");
  const r = spawnSync(ts, ["serve", "--bg", String(cfg.port)], { stdio: "inherit" });
  if (r.status !== 0) { console.log("tailscale serve failed (is Tailscale running / are you logged in?)"); return; }
  const client = new ArtifactsClient();
  try { console.log("public URL: " + await client.publicUrl()); }
  catch (error) { console.log("Serve configured; public URL unavailable — " + (error instanceof Error ? error.message : String(error))); }
}

async function gc() {
  ensureHome();
  // collect referenced blobs
  const used = new Set<string>();
  // lazy import store to avoid sqlite load unless needed
  const dbMod: typeof import("../src/store.ts") = await import("../src/store.ts");
  for (const a of dbMod.listArtifacts({ includeArchived: true, limit: 100000 })) {
    for (const v of dbMod.getVersions(a.id)) used.add(v.blob);
  }
  const blobsDir = path.join(HOME, "blobs");
  let removed = 0, kept = 0;
  if (fs.existsSync(blobsDir)) {
    for (const sub of fs.readdirSync(blobsDir)) {
      const d = path.join(blobsDir, sub);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (used.has(f)) { kept++; continue; }
        fs.unlinkSync(path.join(d, f)); removed++;
      }
    }
  }
  console.log(`gc: removed ${removed} blob(s), kept ${kept}`);
}

function scaffoldApplet(id: string, title: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) die("applet id must match [a-z0-9][a-z0-9_-]{0,63}");
  ensureHome();
  const dir = path.join(APPLETS_DIR, id);
  if (fs.existsSync(dir)) die("applet already exists: " + dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "applet.json"), JSON.stringify({
    id,
    title,
    description: "Tiny pi-artifacts applet",
    entry: "index.html",
    backend: "backend.mjs",
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeTemplateHtml(title)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.5}
input,button{font:inherit;padding:8px 10px} li{margin:6px 0}
</style>
</head>
<body>
<h1>${escapeTemplateHtml(title)}</h1>
<p>This tiny applet stores notes in its own SQLite database.</p>
<form id="form"><input id="text" placeholder="Add a note" required /> <button>Add</button></form>
<ul id="items"></ul>
<script type="module">
const api = "/api/applets/${id}/notes";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function load(){ const r = await fetch(api); const {items=[]} = await r.json(); document.getElementById("items").innerHTML = items.map((x)=>` + "`<li>${esc(x.text)}</li>`" + `).join(""); }
document.getElementById("form").onsubmit = async (e) => { e.preventDefault(); const text = document.getElementById("text").value.trim(); if (!text) return; await fetch(api, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ text }) }); e.target.reset(); await load(); };
load();
</script>
</body>
</html>
`);
  fs.writeFileSync(path.join(dir, "backend.mjs"), `export async function handle(req, res, ctx) {
  const url = new URL(req.url || "/", "http://localhost");
  const prefix = "/api/applets/${id}/";
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  ctx.db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL)");
  if ((path === "notes" || path === "") && req.method === "GET") {
    const items = ctx.db.prepare("SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 100").all();
    return { items };
  }
  if ((path === "notes" || path === "") && req.method === "POST") {
    const body = await ctx.readJsonBody();
    const text = String(body.text || "").trim();
    if (!text) return ctx.json(400, { error: "text is required" });
    ctx.db.prepare("INSERT INTO notes (text, created_at) VALUES (?, ?)").run(text, Date.now());
    return { ok: true };
  }
  return ctx.json(404, { error: "not found" });
}
`);
  return dir;
}

function titleFromId(id: string): string {
  return id.split(/[-_]+/).filter(Boolean).map((s) => s[0]?.toUpperCase() + s.slice(1)).join(" ") || id;
}

function escapeTemplateHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

function pad(s: string, n: number) { s = String(s ?? ""); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function die(msg: string): never { console.error(msg); process.exit(1); }
function dieRetrieval(code: string, message: string): never {
  console.error(JSON.stringify({ ok: false, error: { code, message } }));
  process.exit(1);
}
function need<T>(v: T | undefined, msg: string): T { if (v == null) die(msg); return v; }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
