# Installation and operations reference

For operators and command-line users: installation, daemon management, remote clients, retrieval, publishing, and metadata repair.

## Install the CLI (one-time, on each development machine)

From this checkout:

```bash
npm install
npm link                      # expose this checkout's `pi-artifacts` bin on PATH
pi-artifacts --help
```

A normal `npm install` installs dependencies but does not globally expose the root package's
own `bin` entry. If you do not want a global development link, use
`npm exec -- pi-artifacts <command>` from this repository instead. Registration is available as
both `pi-artifacts add <file>` and `pi-artifacts register <file>`.

## Install the serving daemon (one-time on the store owner)

```bash
pi-artifacts install          # Linux/macOS user service + tailscale serve
# or, without touching tailscale:
pi-artifacts install --no-tailscale
```

Do not install a second daemon on a client device; configure its CLI or extension to use the
serving daemon as described in [Remote clients](#registering-from-a-remote-client-cross-machine).

`install` starts a user service and waits for the daemon before configuring Tailscale Serve:

- **Linux:** writes `${XDG_CONFIG_HOME:-~/.config}/systemd/user/pi-artifacts.service`,
  enables it, and starts it with `systemctl --user`. Reinstalling restarts the service.
  Logs: `journalctl --user -u pi-artifacts.service -n 50`.
- **macOS:** writes `~/Library/LaunchAgents/com.pi.artifacts.plist` (RunAtLoad + KeepAlive).
  Logs: `~/.pi/artifacts/daemon.log`.

Linux requires a working systemd user manager. To keep the service running after logout
and start it at boot without logging in, an administrator can enable lingering with
`sudo loginctl enable-linger "$USER"`. The installer does not change this policy.
On other platforms, or without a user service manager, run `pi-artifacts serve` in the foreground.

A service-manager failure, startup timeout, failed Serve setup, or unavailable explorer URL
makes `install` exit nonzero rather than print “Done.” Use `--no-tailscale` to preserve
existing Serve settings; a configured Serve mapping or explicit public URL is still needed
for the explorer link. `uninstall` stops and removes the current platform's user service
but preserves the artifact store and all Tailscale Serve mappings.

Config lives in `~/.pi/artifacts/config.json`; `port`, `host`, and `clientScheme` are transport
settings only. Install on the store owner with a loopback HTTP transport, not a remote client's
config. The service retains the installing Node executable and supported `PI_ARTIFACTS_*`
runtime settings, plus `PATH` so it can find Tailscale. Reinstall after changing Node versions
or environment settings. Unrelated environment variables and credentials are not copied.
Use `publicBaseUrl` or `PI_ARTIFACTS_PUBLIC_URL` for a validated explicit override when needed.
The daemon otherwise discovers its canonical HTTPS Serve authority, mount, and port automatically.

In pi, run `/reload` to load the extension.

The client address and canonical public URL are reported separately by `pi-artifacts status`;
unavailable or ambiguous Serve mappings produce an actionable message rather than a local or guessed
link.

## Usage

### From a pi session

The agent can call the **`artifact`** tool, or you can use slash commands:

```
/artifact <path> [title…]      register a file (referenced: live pointer + snapshot)
/artifacts                     list this project's artifacts + explorer URL
/artifacts open                print the explorer URL
/artifacts-url                 print the explorer URL
```

Use **`artifact_comments`** to read durable viewer threads from an immutable snapshot. Its
transcript is intentionally bounded; complete comment, reply, author, selector, and placement
records are returned in tool `details`. Agent writes are always explicit—reading never posts.

```json
{ "id": "<artifact-id-or-view-url>", "versionId": 3, "status": "open", "limit": 50 }
```

Use **`artifact_comment_create`** to post an agent-authored top-level review finding. It requires
an explicit immutable `versionId` plus a complete selector from the rendered corpus (`type`,
`start`, `end`, exact `quote`, `prefix`, `suffix`; HTML also requires `selector`). Use
**`artifact_comment_reply`** with the exact parent comment id to append an agent reply without
changing the thread's open/resolved status. Neither write tool runs automatically. Both use
content-derived operation ids (idempotent replay, no duplicates) and honor cancellation. Agent
comments are immutable — the daemon returns `403 ANNOTATION_FORBIDDEN` for any body edit or delete,
even from a viewer script — and agent writes appear in an open viewer only after a reload.

In a source checkout, run browser annotation coverage with `node --test tests/*.e2e.mjs`.
It uses Playwright Chromium; install its browser with `npx playwright install chromium` when it
is not already available. On iOS, offline annotation replay still happens only while the page
is active (open, focused, visible, or newly
online), so physical Safari touch/background behavior remains a release smoke-check item.

### Immutable snapshot retrieval

Retrieve the current or an explicit historical stored snapshot without following a referenced live source:

```jsonc
{ "action": "get", "id": "<artifact-id>" }
{ "action": "get", "id": "<artifact-id>", "version": 42, "output": "tmp/report.md" }
```

The CLI prints the same JSON result shape:

```bash
pi-artifacts get <artifact-id>
pi-artifacts get <artifact-id> --version 42 --output ./report.md
```

Success metadata always includes `artifactId`, `version`, `title`, `kind`, `mime`, `byteLength`, and `sha256`, with `disposition` set to `inline` or `materialized`. Valid UTF-8 Markdown, HTML, and code snapshots with a compatible text MIME type up to and including 64 KiB return exact `content`. Larger text, invalid UTF-8, binary, unsupported kinds, and kind/MIME conflicts are written as exact bytes to `path`; `--output` always forces a file. Downloads stream to a collision-safe staging file, verify byte length and SHA-256, then atomically replace the requested output. Failed or interrupted downloads remove partial files. A caller cancellation or active-transfer close is `INTERRUPTED`; setup, timeout, and pre-response transport failures are `TRANSPORT_ERROR`.

Retrieval uses configured local or remote HTTP/HTTPS transport, is not scoped to the caller's project, and returns stable error codes including `INVALID_ARTIFACT_ID`, `INVALID_VERSION`, `ARTIFACT_NOT_FOUND`, `VERSION_NOT_FOUND`, `SNAPSHOT_UNAVAILABLE`, `LENGTH_MISMATCH`, `HASH_MISMATCH`, `INTERRUPTED`, `TRANSPORT_ERROR`, and `OUTPUT_ERROR`.

### From any shell (CLI)

```bash
pi-artifacts add report.html --title "Q3 Review" --tags review,q3
pi-artifacts register demo.mp4 --title "Demo recording"  # alias for add
pi-artifacts add interview.m4a --stored
pi-artifacts add scene.data --mime model/gltf-binary
pi-artifacts add notes.md --stored                 # snapshot-only
pi-artifacts publish <artifact-id|report.html> [--name stable-project-name]
pi-artifacts list [--project P] [--q text] [--sort modified|created|project|title]
pi-artifacts open [id]                              # print + open URL
pi-artifacts applets                                # list small applets
pi-artifacts applet-init <id> [--title T]           # scaffold one
pi-artifacts tag <id> a,b,c
pi-artifacts archive|restore <id>
pi-artifacts rm <id>                                # delete (blobs pruned by gc)
pi-artifacts repair-types --dry-run                 # preview kind/mime repairs inferred from bytes
pi-artifacts repair-types --apply                   # repair mismatched stored kind/mime metadata
pi-artifacts gc                                     # prune unreferenced blobs
pi-artifacts status | url
pi-artifacts uninstall                              # remove user service; keep store and Serve
pi-artifacts tailscale | tailscale-off              # (re)configure / reset serve
```

`--project` defaults to the current git repo name; mode defaults to `referenced`. Common media
types are inferred from filenames and signatures; use `--mime type/subtype` for uncommon
browser-native formats.

## PreviewShip external publishing

PreviewShip support is deliberately opt-in: `add` / `add_content` only register inside the
private pi-artifacts daemon. Publishing happens only through `artifact` action `publish`,
`/artifact-publish`, or `pi-artifacts publish` and uploads data to an external service.

One-time setup on the **daemon host**, as the same OS user that runs pi-artifacts:

```bash
npx previewship login
# non-interactive alternative (avoid shell history when possible):
PREVIEWSHIP_API_KEY=ps_live_... pi-artifacts serve
```

The daemon uses PreviewShip's official `previewship` package. Authentication precedence is
`PREVIEWSHIP_API_KEY`, then `~/.previewship/config.json`. The API key is never stored in the
pi-artifacts database or returned to clients.

Publish an existing artifact or register-and-publish one HTML/Markdown file:

```bash
pi-artifacts publish 4f0d5c9a110e
pi-artifacts publish report.html --name quarterly-review
pi-artifacts publish README.md --stored --json
```

From the agent tool:

```jsonc
{ "action": "publish", "id": "4f0d5c9a110e" }
{ "action": "publish", "path": "report.html", "projectName": "quarterly-review" }
```

Only registered HTML and Markdown snapshots are supported. Publishing always uses the stored
snapshot for the current artifact version—not unregistered live-file changes—so the recorded
version and external bytes agree. Generated PreviewShip project names include the artifact ID to
avoid collisions; a custom or previously recorded name is remembered and reused, preserving the
fixed URL across republishes. Registering a newer version marks the explorer's PreviewShip badge
stale until the artifact is published again.

The publish endpoint requires an agent-only `Sec-*` request marker that browser JavaScript cannot
set, and rendered HTML runs in an opaque-origin sandbox. Consequently, artifact content can render
scripts but cannot trigger credentialed PreviewShip publishing through the viewer. This marker is a
browser boundary, not a general tailnet authentication mechanism; the daemon remains intended for
a trusted tailnet.

Password configuration is intentionally not accepted through the agent tool (tool arguments are
session history). Manage project access separately with PreviewShip's CLI. Republishing omits an
access override, so an existing project's current public/password setting is preserved.

## Registering from a remote client (cross-machine)

Point the CLI/extension at the serving daemon over the tailnet. Set in the client's
`~/.pi/artifacts/config.json` (or env):

```jsonc
{
  "host": "daemon.example.com",
  "port": 443,
  "clientScheme": "https"
}
```

`clientScheme` controls transport only. Keep `http` for a loopback daemon or use `https` for a
remote daemon endpoint. The serving daemon, not this client configuration, supplies every ordinary
artifact, annotation, explorer, and applet URL. Automatic discovery preserves a mapped path and
non-default HTTPS port; an explicit `publicBaseUrl`/`PI_ARTIFACTS_PUBLIC_URL` override is validated
and preserves its scheme, port, and base path. For example: `https://daemon.example.com:8443/artifacts/`.

The register call streams the file's bytes, so large media does not need JSON/base64 wrapping or
whole-file buffering and the snapshot always works. The daemon defaults to a 4 GiB per-file limit;
override it with `PI_ARTIFACTS_MAX_UPLOAD_BYTES` when needed. Crash-left `upload-*` staging files
are reclaimed after 24 hours without touching unrelated files. New clients negotiate streaming
support and retain a bounded legacy JSON fallback for files up to 45 MiB. A source path received
over a remote connection is snapshot-only by design; local trusted registrations render live when the
daemon can read the path and otherwise transparently fall back to the snapshot.

## Repairing artifact type metadata

If an older inline artifact was registered without a filename extension, it may have been stored
as `kind=other` / `application/octet-stream` even though the bytes are Markdown or HTML. Preview
and apply metadata-only repairs with:

```bash
pi-artifacts repair-types --dry-run
pi-artifacts repair-types --apply
```

The repair runs through the daemon, sniffs stored snapshot bytes, and updates artifact + current
version kind/mime metadata without changing artifact IDs or blob content.
