# pi-profile

Named, isolated [Pi](https://github.com/earendil-works/pi) profiles.

A profile is a separate Pi agent directory with its own settings,
extensions, sessions and, if you want, its own credentials. `pi-profile`
creates and switches profiles, checks them, and shows the active profile as a
coloured badge in Pi's status bar.

## Install

```sh
pi install npm:@centerforagenticai/pi-profile      # the status badge and /profile command
npm install -g @centerforagenticai/pi-profile      # the pi-profile command
```

Then add the shell integration, which `pi-profile use` and `pi --profile`
need:

| Shell | Add this line | To this file |
|---|---|---|
| fish | `pi-profile shell-init fish \| source` | `~/.config/fish/config.fish` |
| bash | `eval "$(pi-profile shell-init bash)"` | `~/.bashrc` |
| zsh | `eval "$(pi-profile shell-init zsh)"` | `~/.zshrc` |

## Use

```sh
pi-profile create work --color teal --description "day job"
pi --profile work                 # run Pi once in a profile
pi-profile use work               # switch this shell
pi-profile default set work       # new shells start in work
pi-profile list
pi-profile doctor                 # check every profile
pi-profile sync init HOST:PATH    # use a bare git repository on a tailnet machine as the config hub
pi-profile sync push [NAME...]    # commit each profile's config to its hub and push
pi-profile sync pull [NAME...]    # write each hub's config into the profiles here
pi-profile sync status [NAME]     # class each path as config, state, secret, sessions or unknown
pi-profile sync status [NAME] --allow-line PATH:LINE  # print the allowFindings entry for a checked line
```

Session storage:

```sh
pi-profile sessions store add NAME /absolute/path
pi-profile sessions store list
pi-profile sessions store remove NAME
pi-profile sessions use NAME [--profile PROFILE | --all]
pi-profile sessions migrate FROM TO           # dry run: what would move
pi-profile sessions migrate FROM TO --apply   # copy, verify SHA-256, then remove
```

`FROM` and `TO` are store names or absolute paths. Files changed in the last
10 minutes, lock files, and any session file `<name>` with a lock beside it
when the run starts (any `<name>.*.lock`, such as `<name>.pi-daemon.lock`) are
left for a later run. During `--apply`, before each copy and each removal,
only `<name>.pi-daemon.lock` and `<name>.lock` are checked again; a lock with
any other name that appears mid-run is not noticed. A file is never moved
through a folder in `TO` that links outside `TO`. A file in `TO` where a
folder is needed, or a folder in `TO` where `FROM` has a file, is reported
as a conflict for the sessions it affects; the other sessions still move.
On Linux each destination folder is held open from `TO` down while the copy
is written, so swapping a folder for a link mid-run cannot send the copy
outside `TO`. Without `/proc/self/fd` (macOS), a folder above the last one
swapped at the wrong moment can still leave a stray copy outside `TO`; the
source is always kept then.
An interrupted run never loses a file; run it again to finish.

A **session repository** is a directory one device offers so your other devices
can back up their sessions into it:

```sh
pi-profile repo advertise NAME /absolute/path   # create repository.json, offer it
pi-profile repo list                            # what this device offers
pi-profile repo discover                        # what your devices offer
```

`repo discover` asks only your own online Tailscale devices (never tagged
servers), over `ssh -o BatchMode=yes`, and reads `~/.pi/pi-profile/advertised.json`
on each. A device it cannot reach (a phone, or one without SSH access) is listed
on stderr as skipped.

Back up this host's sessions to a disk, a device or S3:

```sh
pi-profile backup add usb local /media/usb/pi-sessions
pi-profile backup add studio ssh good-kiwi-studio sessions   # a repository the device advertises
pi-profile backup add cloud s3 s3://my-bucket/pi --encrypt-to age1...
pi-profile backup run                                        # or --replica ID
pi-profile backup list                                       # last run of each
```

Backups go under `hosts/<this host>/sessions/` and never delete anything.
They need `rsync`, plus `age` for encrypted replicas and `aws` or `rclone`
for S3. S3 replicas are encrypted unless you pass `--no-encrypt`; keep the age
private key safe, because without it those backups cannot be read.
Encryption hides session contents, not folder or file names. If a
replica's copies are lost, `pi-profile backup run --full` sends everything
again.

A backup stages the sessions it sends as hard links under
`~/.pi/pi-profile/state/backup`, so they take no extra space. If the store is
on another file system, it copies them there instead, 256 MiB at a time. A
session that changes or is replaced between the scan and the copy (another
inode, or the same inode with another size, mtime or birth time) is skipped
and sent by the next run. A
session that has become smaller than its copy in a replica is held back, even
after `--full` or a change of age recipients; a new replica target gets every
session.

To back up whenever a Pi session ends, add `autoBackup` to
`~/.pi/pi-profile/config.json`:

```json
{
  "schemaVersion": 1,
  "hostId": "my-laptop",
  "sessionStores": { "main": { "path": "/home/user/pi-sessions" } },
  "replicas": [{ "id": "usb", "kind": "local", "path": "/media/usb/pi-sessions" }],
  "autoBackup": { "onSessionEnd": true, "minIntervalSeconds": 300 }
}
```

When a session ends (quit, `/new`, `/resume` or a fork; not `/reload`), the
extension starts `pi-profile backup run --quiet --auto` in the background, at
most once every `minIntervalSeconds`, even when several sessions end at once.
A session that ends inside the interval, or while a run is in progress,
starts nothing; it is marked pending. The background run waits until the
interval has passed and, if a session is pending, runs once more. It makes at
most 3 such extra runs, then exits. If a session is marked pending and no
background run is left to act on it (it was killed, reached its 3 extra runs,
or stopped on an error), the session end starts one that waits for the
interval and then runs; it does this at most once per interval. While it
waits, the run sits in `/`, so it does not keep the home's drive busy. The run is detached, so quitting Pi never waits for it, and it keeps going after
Pi exits. Its output goes nowhere. `pi-profile backup list` shows the time
of each replica's last successful backup; a failed or refused run leaves that
time unchanged and reports nothing else. The background run needs Pi to be
running on Node; when Pi is a Bun or single-executable build, auto-backup is
skipped. Auto-backup is off when `autoBackup` is absent or `onSessionEnd` is
`false`. `onSessionEnd` is required; `minIntervalSeconds` defaults to 300.
An invalid `autoBackup` makes every pi-profile command refuse to read the
config, not just auto-backup, until you fix it; the extension then skips the
backup rather than stopping Pi. The time of the last automatic start, the
pending mark and the waiting run's process ID and start time are kept in `~/.pi/pi-profile/state/autobackup/last.json`,
which never leaves the host.

A crashed pi-profile can leave a lock breaker
(`.pi-profile.lock.break`) in `state/autobackup/` or `state/backup/`, which
makes backups refuse. When a session ends, auto-backup removes such a breaker
if it is older than 10 seconds, the process that wrote it is gone, and the
lock beside it is gone or its holder is gone. `pi-profile doctor` reports any
breaker older than 10 seconds there and prints the `rm` command to remove
it, with the path quoted for the shell; run it only when no pi-profile is running.

Read other devices' sessions from a replica:

```sh
pi-profile sessions pull usb                # every other host
pi-profile sessions pull studio --host kiwi # one host
pi-profile sessions pull s3 --identity ~/.config/age/pi.key # encrypted replica
pi --fork ~/.pi/pi-profile/remote/kiwi/sessions/<folder>/<file>.jsonl
```

`sessions pull` copies other hosts' `hosts/<host>/sessions/` into
`~/.pi/pi-profile/remote/<host>/sessions/`. New copies are read-only. Fork
one to continue it; the fork is this host's session. pi-profile refuses to use
the pulled copies as a session store or a `sessions migrate` source, even
through a link, so they are never backed up as this host's. A pull replaces
copies that changed and never removes a file. If the replica will not let it
read some session files, it pulls the rest, names those files and exits 1. A session that its host is
backing up while you pull may arrive with a half-written last line; the next
pull repairs it. Use rsync 3.2.5 or later on this host, so that it checks the
file names a peer sends.

S3 and encrypted replicas are pulled in two steps. pi-profile first downloads
the session files into a private folder under `~/.pi/pi-profile/state/pull/`:
with `aws s3 cp` or `rclone copy` for S3, and with rsync for an encrypted
`local` or `ssh` replica. The download is filtered, so other objects are not
fetched. pi-profile then checks each downloaded file again. It keeps only
`<host>/sessions/<folder>/<name>.jsonl`, or `.jsonl.age` for an encrypted
replica, from other hosts whose folder is a host ID. Hidden names, names with
control characters, links and deeper paths stay behind. So do names that are
not UTF-8 (the pull prints a warning without the name) and names with a part
longer than 255 bytes, which no folder can hold. Each `.age` file is
decrypted with `age --decrypt -i FILE`, and the session goes into the same
read-only `remote/<host>/sessions/` tree as a plain pull. The download folder
is then removed. If `aws` or `rclone` fails on some objects, or a file will
not decrypt or cannot be saved, the other files are still pulled; the pull
names each failure and exits 1. A pull also removes the temporary files a
killed pull left in any session folder under `remote/`, once they are 10
minutes old; it keeps another user's and never follows a link.

Before it reports an empty S3 pull, pi-profile checks that some
`hosts/<host>/host.json` exists under the replica's URI. If none does, the
pull fails (exit 1): nothing was backed up there, or the bucket, prefix or
rclone remote is wrong.

An encrypted replica needs the age identity (private key) file that matches
one of its recipients. Give it with `--identity FILE`, or set an absolute
path in `pullIdentity` in `~/.pi/pi-profile/config.json`. `--identity` wins.
Without either, the pull refuses. pi-profile never reads an identity from a
replica, refuses an identity file inside a `local` replica, and never prints
the identity path; only `age` receives it, as a path. A pull cannot ask for a
passphrase, so it refuses an identity file that is itself encrypted with one.
Decrypt it to a file only you can read (`age --decrypt -o FILE`) and give that.
An SSH identity with a passphrase is refused too. Remove the passphrase from
a copy only you can read (`ssh-keygen -p -f COPY`) and give that.

`pi-profile help` lists every command.

## In Pi

The extension shows the active profile in Pi. The plain default profile
shows nothing and keeps Pi's own title.

- **Badge**: `● work` in the status bar, in the profile's colour. When this
  host backs up over SSH to repositories and owns none of them, the badge also
  names the host: `● work · laptop`. On the host that owns the repository, and
  with no `ssh` replicas, the host is not shown.
- **Terminal title**: `π work · proj`, where `proj` is the last part of the
  session's working directory. It is set when a session starts, resumes or
  forks, again over the next second (Pi writes its own title once its
  extensions finish loading), and after a session rename.
- **`/profile`**: shows the active profile and how it was chosen.
- **`/profile status`**, **`/profile list`**, **`/profile doctor`**: run
  `pi-profile status --json`, `list --json` or `doctor --json` in the
  background and show the result when it ends, so Pi stays usable. `status`
  shows the profile, this host and each replica's last backup; `list` marks
  the active profile with `*`.
- **`/profile switch NAME`**: a running Pi cannot change its profile, so this
  names the command that starts Pi in NAME: `pi-profile run NAME` (or
  `pi --profile NAME` with the shell integration). Any other argument shows
  the usage.
- **`/profile backup`**: starts `pi-profile backup run --json` in the
  background and shows `backup: started` at once, so Pi stays usable. When the
  run ends it shows one line per replica. A failed replica shows only
  `failed`; run `pi-profile backup list` or `pi-profile backup run` in a
  shell for the reason. A second `/profile backup` is refused while one runs,
  and the run takes the same backup lock as any other `backup run`, so it
  never overlaps an automatic backup.

## Where things live

| Path | What it is |
|---|---|
| `~/.pi/agent` | The `default` profile: Pi's own agent directory |
| `~/.pi/profiles/NAME` | Each other profile |
| `~/.pi/profiles/NAME/profile.json` | The profile's settings (the manifest) |
| `~/.pi/profiles/.global-default` | The profile new shells start in |
| `~/.pi/profiles/.trash` | Deleted profiles, as `NAME-YYYYMMDD-HHMMSS` (with `-2`, `-3`, ... for a second delete of NAME in the same second); nothing is removed |
| `~/.pi/pi-profile/remote/HOST` | Sessions pulled from other hosts (read-only) |
| `~/.pi/pi-profile/state` | Machine-local backup, auth-sync and config-sync state; never replicated |

Set `PI_PROFILE_HOME` to use another directory than `~/.pi`. Set
`PI_PROFILE_NO_GLOBAL_DEFAULT` to make a shell ignore the global default.

Config sync stores paths in `settings.json` and
`profile.json` as path tokens: a value that starts with your home directory
becomes `${HOME}`, and one that starts with your code root becomes `${CODE}`.
The code root is `codeRoot` in `~/.pi/pi-profile/config.json` (an absolute
path, such as `"codeRoot": "/srv/code"`); it defaults to `~/Code`. Each host
expands the tokens with its own paths. `sessionDir` is never synced; each host
sets it from the profile's own session store (`sessions.store` in
`profile.json`), as `pi-profile sessions use` does. A token pi-profile does not know, such
as `${USER}`, is left unchanged and reported.

## Credentials

Each profile has one of three auth modes:

| Mode | `auth.json` in the profile |
|---|---|
| `shared` (default) | A link to `~/.pi/agent/auth.json`; log in once for every profile |
| `separate` | The profile's own file; log in again inside the profile |
| `pooled` | The profile's own file; refreshed OAuth logins are pushed to your other devices |

A new `separate` or `pooled` profile starts with no credentials. Add
`--copy-auth` to start from a copy of the shared file. Switching a profile to
`shared` keeps its old file as `auth.json.bak-<time>-<random>`. pi-profile never
deletes that file: it may hold the only copy of a private login.

### Moving credentials between devices

Log in on one device, then copy the login to another of your devices over
Tailscale SSH:

```sh
pi-profile auth push good-kiwi-studio                      # every entry of this profile
pi-profile auth push good-kiwi-studio --provider anthropic # only these providers
pi-profile auth pull good-kiwi-studio --profile work       # fetch and merge here
```

`auth export` prints credentials, so it refuses to print to a terminal; pipe
its output. Both ends need pi-profile on the PATH that `ssh HOST` runs, and the same
profile name. `HOST` must be a Tailscale short name (lower-case letters,
digits and `-`). The credentials travel only on the stdin and stdout of
`ssh -o BatchMode=yes HOST pi-profile auth receive` (push) or `auth export`
(pull); they are never in a command line, a log or a message. Output names
providers and outcomes only: `added`, `replaced`, `kept` or `unchanged`.

The receiver merges by provider. Other providers are left alone.

| Local entry | Incoming entry | Result without `--force` |
|---|---|---|
| none | any | added |
| API key | anything | kept |
| OAuth login | API key | kept |
| OAuth login | OAuth login | the one with the later `expires` |

`--force` takes the incoming entry in every case. An entry that is not an
`api_key` or `oauth` entry, or has fields pi-profile does not know, is
refused, never merged; a payload larger than 1 MiB is refused. An OAuth
login whose `expires` is more than a year away is refused: it would win every
later merge and never refresh.

Pi runs an API key that starts with `!` as a shell command. `auth receive`
and `auth pull` refuse such a key unless you pass `--allow-command-keys`
(`auth push --allow-command-keys` passes it to the receiver). Other values,
such as `$NAME`, only read the environment and are accepted.

`auth pull --provider X` merges only the providers you name. Anything else
the peer sends is dropped, and a warning names it.

The receiver writes the file the profile's mode names: the shared
`~/.pi/agent/auth.json` in `shared` mode, the profile's own file otherwise.
It holds Pi's own lock at every path a Pi may lock for that file: Pi locks
`<agent dir>/auth.json.lock` without following links, so a shared write locks
`~/.pi/agent/auth.json.lock` and `profiles/<name>/auth.json.lock` for every
profile that links to the shared file. It takes them in a fixed order and
releases them all. A profile counts as linked when its `auth.json` finally
resolves to the shared file, through any chain of links or a symlinked home;
a dangling or looping link counts as not linked. It breaks a lock only when it is older than 45 s (Pi's
30 s stale time plus a margin), and only if it is still the same lock it
judged stale. A breaker file `<lock>.break` left by a crashed pi-profile is
removed once it is older than 60 s; a newer one is named in the refusal.
It is linked aside first, so a breaker is always on disk while it is cleared.
A leftover `<lock>.break.stale-<hex>` from a crash during that step is
removed when it is older than 60 s; links are never followed.
`auth export` and the pooled checks only read: they wait for a lock and never
break one.

It keeps the old contents as `auth.json.bak-sync-<time>-<random>` (mode 0600)
beside the file, then rewrites the file in place with mode 0600, as Pi does,
so a shared link stays a link. It keeps the newest 5 of these sync backups
and deletes older ones (only regular files with exactly that name; a
mode-switch backup is never deleted). Nothing is written when nothing
changes. Backups hold credentials: like `auth.json`, they never go to a
session backup or a migration. Neither do `auth.json.aside-*` and
`auth.json.new-*`, which a crash can leave; these names match in any case.

### Pooled profiles

A `pooled` profile pushes refreshed OAuth logins to the devices listed in
`authSync.peers` in `~/.pi/pi-profile/config.json`:

```json
{ "schemaVersion": 1, "hostId": "my-laptop", "sessionStores": {}, "authSync": { "peers": ["good-kiwi-studio"] } }
```

When a session in a pooled profile starts, the extension records the size,
time and SHA-256 of `auth.json` and of each entry in
`~/.pi/pi-profile/state/authsync/` (hashes only; never leaves the host). When
the session ends, if the file changed, it starts `pi-profile auth sync` in
the background, as auto-backup does. That run sends only OAuth entries that
changed, never an API key, to the same profile on each peer, which keeps the
later login. A peer that fails gets the same entries again after a wait of
5 minutes, doubling after each failure, at most 24 hours. A saved wait that
is damaged is dropped, and one longer than 24 hours (for example after a
clock was far ahead) is cut to 24 hours. `pi-profile auth
status` shows each peer, the entries it waits for, and its last error (ssh's
last stderr line; never a credential). `shared` and `separate` profiles
never push on their own.

Providers that rotate refresh tokens invalidate the old token on refresh, so
two devices that refresh the same login at the same time can log one out.
Pooled mode narrows that window; it does not close it. Logging in on each
device is still the safe default.

### API keys in `models.json` and `web-search.json`

Keep API keys out of these two files. Put a reference to an environment
variable in the key field, and set the variable outside the profile. Then
`sync push` can carry the file, and the key never goes to the hub.

```json
{ "providers": { "work-llm": { "baseUrl": "https://llm.example.com/v1", "apiKey": "${WORK_LLM_API_KEY}" } } }
```

```json
{ "provider": "exa", "exaApiKey": "${EXA_API_KEY}" }
```

- `models.json` (Pi): `apiKey` and each `headers` value of a provider, a
  model and a `modelOverrides` entry. Pi expands `$NAME` and `${NAME}`
  anywhere in the value, so `"Authorization": "Bearer ${WORK_LLM_TOKEN}"`
  works, and runs a value that starts with `!` as a command.
- `web-search.json` (pi-web-access): every provider key field, such as
  `exaApiKey`, `braveApiKey`, `tavilyApiKey`, `geminiApiKey` or
  `crawl4aiApiToken`. Only the whole value is a reference: `$NAME`,
  `${NAME}` or `!command`. You can also delete the field and set the
  provider's own variable, such as `EXA_API_KEY`.

Set the variables in your shell, for example in `~/.bashrc` or
`~/.config/fish/config.fish`, or from a password manager there.
`pi-profile run` and `pi-profile use` pass your shell's environment to Pi.
To give two profiles different keys, use a different variable name in
each profile's file (`WORK_LLM_API_KEY`, `HOME_LLM_API_KEY`). Every device
that runs the profile needs the variable set.

Do not put a key in `env` in `profile.json`: `profile.json` goes to the
hub, and `env` takes only the variables pi-profile knows, none of them a
key. `profile-env.json` stays on the host but takes the same short list.

`pi-profile doctor` names each field that still holds a literal key, never
the value. Only a whole reference counts as one (`${NAME}`, `$NAME`,
`!command`, or `Bearer ${NAME}` in a header). `key-${NAME}`, a bare
`NAME` and `$$…` still count as literal keys. A `!command` goes to the hub
as text and runs on every device that uses the file, so keep it to a
command you trust on all of them.

## The manifest

```json
{
	"schemaVersion": 1,
	"name": "work",
	"description": "day job",
	"color": "teal",
	"auth": { "mode": "shared" },
	"multiAccount": { "group": "caair" },
	"env": { "ACP_AUTO_UPDATE": "0" }
}
```

Unknown keys are refused, so a credential cannot be put in the manifest by
mistake. `env` accepts only these variables:

`PI_MEMORY_DIR`, `PI_MEMORY_SNAPSHOT`, `PI_MEMORY_QMD_UPDATE`,
`PI_MEMORY_EXIT_SUMMARY`, `ACP_AUTO_UPDATE`, `ACP_DELEGATE`, `ACP_LOG_FILE`,
`ACP_UPDATE_THROTTLE_FILE`.

Path values must be absolute and inside the profile. Switching profiles
clears every variable in this list that the new profile does not set.

Profiles made by the older fish utility work without a manifest; run
`pi-profile adopt --all` to write one for each.

## Config hub

A config hub is a bare git repository on a machine in your tailnet, reached
over SSH. Make it once on that machine, then point each host at it:

```sh
ssh good-kiwi-studio git init --bare pi-hub.git
pi-profile sync init good-kiwi-studio:pi-hub.git
pi-profile sync push            # every profile; or name some
```

`sync init` records the hub in `~/.pi/pi-profile/config.json` as
`"hubs": { "default": { "remote": "good-kiwi-studio:pi-hub.git" } }` and keeps
a bare mirror in `~/.pi/pi-profile/sync/default.git`. A remote is
`HOST:PATH` or `ssh://HOST/PATH` with a Tailscale name, or a local path.
https, a host outside the tailnet (such as gitlab.com) and other git
transports are refused. Add another hub with `--hub NAME`, and send a
profile to it with `"sync": { "hub": "NAME" }` in its `profile.json`; a
profile with no `sync.hub` uses `default`.

`sync push` copies each profile's config files to `profiles/<name>/` in the
hub, with `settings.json` and `profile.json` in portable form, commits as
`<host>: <profiles>` and pushes. A profile that is a link to another is
recorded in `hub.json` as an alias, not copied. A file that may not sync is
listed with its reason and left out; the hub keeps its last copy. While
`models.json` or `web-search.json` holds a literal API key, it is left out
for that reason; once each key is an environment variable reference, it is
pushed (see [API keys in `models.json` and `web-search.json`](#api-keys-in-modelsjson-and-web-searchjson)). Before each commit every staged path is checked again: a
credential name such as `auth.json`, a path that is not `config`, or a
credential-looking value refuses the whole commit, and nothing is pushed.
`auth.json` never goes to the hub; use `pi-profile auth`.

When another host pushed first, `sync push` fetches the hub and stops. It
never merges: run `pi-profile sync pull` first, then push again.
`sync push` reads `~/.pi/pi-profile/state/sync/last.json` before it sends
anything, so a broken file refuses the push with the hub unchanged. If the
push lands but cannot be recorded there, it prints `pushed` with a warning
and exits 1: do not push again. A hub that
fails is reported and the other hubs are still pushed; the command then exits
nonzero.

### sync pull

```sh
pi-profile sync pull                 # every profile in every hub
pi-profile sync pull work --dry-run  # print what would change
```

`sync pull` fetches each hub and writes its config files into the profiles
on this host. It expands `${HOME}` and `${CODE}` with this host's paths and
sets `sessionDir` from this host's session store. A profile this host does
not have is created, with its `auth.json` linked as `create` does; an alias
in `hub.json` becomes a link to its profile. Each file is written to a
staged copy and renamed into place, so a pull that is killed leaves every
file whole. A file the hub no longer holds is removed, if it is unchanged
here. `auth.json`, state, sessions and unknown paths are never touched.

The hub is not trusted: the pulled commit is checked as `sync push` checks
its own, and a link, a path outside `profiles/<name>/`, a credential name, a
file that is not `config`, a credential-looking value or a file over 1 MiB
refuses the whole hub before anything is written.

pi-profile records what it last agreed with the hub in
`~/.pi/pi-profile/state/sync/last.json`. When a file changed here and the
hub changed it too since then, `sync pull` writes nothing, lists the files
and exits 2. A first pull onto a file that differs from the hub is such a
conflict too. Pick a side:

- `--theirs` writes the hub's copy of each conflicting file, and lists each
  one. It also takes the hub's copy of a file only you changed here: in
  every profile you name, or, with no name, only in a profile that has a
  conflict or a hold. An unpushed edit in another profile is kept;
- `--keep-local` keeps the file here and records the pull, so the next
  `sync push` sends it.

The refusal names the profiles with a conflict, for example
`pi-profile sync pull --theirs p`. Run that with `--dry-run` first: it lists
each file it would overwrite.

A file you changed here that the hub did not change is kept, without a flag.
When the hub did not change a file but it renders differently for this host
than at the last sync (say the profile moved to another session store, so
`sessionDir` changes), it is written if you did not change it here, and is
a conflict if you did. A `sessionDir` you set by hand, with no
`sessions.store`, is left alone by a pull that changes nothing.

Each file is classed under the sync rules of the `profile.json` the profile
has after the pull, so a file the other host added with `sync.include`
arrives too. A file that is still not `config` here is listed and not
written, and the profile counts as not pulled in full: `sync push` of it
is refused, so it cannot drop that file from the hub. The pull names the
files and the two ways out:

- `pi-profile sync pull --theirs NAME` takes the hub's copy of the
  profile, its `profile.json` and sync rules too; or
- add the path to `sync.include` in the profile's `profile.json` here
  (and drop a `sync.exclude` that matches it), then `sync pull NAME`.

A push also refuses to remove from the hub a file of the profile that this
host never pulled or pushed, such as a file another host added before this
host's first pull. Pull first. A hold counts only for the hub the pull read:
after you move the profile to another hub with `sync.hub`, a push there is
not blocked by it.

When the profile is a link to another profile here (an alias), `sync pull`
does not write into the link, so the refusal prints numbered steps instead:
remove the link, `sync pull` (every profile, so NAME is pulled as a real
profile and the other profiles are pulled too), `pi-profile delete NAME --yes`
(the pulled copy goes to `~/.pi/profiles/.trash`, so no file is lost), link
it again, and `sync push NAME`. If that `sync pull` refuses, for a file
changed here and in the hub, follow the way out it prints, then go on from
the same step. The alias push builds on the hub's latest commit, so it
works even while another profile is left out or moved again; it still
refuses if the hub holds a file of NAME this host has not pulled. When NAME is the global default, the steps
also run `pi-profile default clear` before the delete and
`pi-profile default set NAME` after the link is back, because `delete`
refuses the global default.

When a hub copy of a profile has no `profile.json`, the pull never removes
`profile.json` or `settings.json` here. It refuses that profile, and the
others still pull. Keep this host's copies with
`pi-profile sync pull --keep-local NAME`; the next `sync push NAME` puts
them back in the hub. This works even while other profiles in that hub
are still to be pulled: the push builds on the hub's latest commit, changes
only NAME, and leaves the other profiles in the hub as they are.

When every profile of a hub is pulled in full, the next `sync push` builds
on the pulled commit and the hub takes it as a fast-forward.

`sync pull` lists the `packages` in each pulled profile's `settings.json`,
as it is here after the pull, that are missing on this host. A package you
removed here and kept is not listed and not installed. It installs none of them unless you add
`--install-packages`: then it runs `pi install SOURCE` with
`PI_CODING_AGENT_DIR` set to the profile, for `npm:` and `git:` sources only,
and prints each command (`running: PI_CODING_AGENT_DIR=DIR PI_PROFILE_LABEL=PROFILE pi install SOURCE`)
before it runs it. `--dry-run` installs and prints none.
A local path is listed, never installed. A failed install is listed, the
rest still run, and the command exits 1.

### The Pi version pin

Each hub can hold the Pi version the fleet should run:

```sh
pi-profile pin                  # each hub's pin, and whether the Pi here matches
pi-profile pin 1.1.0            # pin hub default to an exact version
pi-profile pin '^1.1.0' --hub work
pi-profile pin --clear          # remove the pin
pi-profile sync push            # records the pin in the hub
```

A pin is an exact version (`1.1.0`, or a prerelease such as `1.2.0-rc.1`),
`^1.1.0` (same major version; for `0.x`, same minor), `~1.1.0` (same minor
version) or `>=1.1.0`. Matching follows npm. Any other form (`1.x`, `*`,
`latest`, `>1.0.0`, `||`) is refused with exit 2.

`pin` writes the pin on this host only. The next `sync push` records it in
`hub.json`, also for a hub that no profile here follows: then the push
makes a commit that changes only `hub.json` and prints
`hub NAME: pushed SHA (Pi version pin only)`. `sync pull` on another host
prints `Pi version pin moved from X to Y` and records it there.

When this host set a pin it has not pushed yet and another host moved the
hub's pin to another value, the pin changed on both sides. `sync pull`
writes nothing, lists the hub with both pins and exits 2, as for a file
changed on both sides. It prints two ways out, and neither overwrites a
file of this host:

- `pi-profile pin HUBPIN` (the hub's pin, as printed; `--hub NAME` for
  another hub, `--clear` when the hub has none) sets this host's pin to the
  hub's, so nothing is left to push. It settles only the pin;
- `pi-profile sync pull --keep-local NAME...` keeps this host's pin, and
  this host's copy of any file changed on both sides in those profiles.
  The next `sync push` writes the pin to the hub and says which pin it
  replaced: `Pi version pin 1.0.4 recorded, replacing the hub's 1.1.0`.

`pi-profile sync pull --theirs` also takes the hub's pin, but it takes the
hub's copy of files too: each file changed on both sides, and in a profile
that conflicts (or with names, in every named profile) each file changed
only here. It lists each file only after it has overwritten it, so run it
with `--dry-run` first. The pin's ways out never print it.

The pin belongs to a hub, so the flags settle the pin of each hub the pull
reads: every hub with no names, or the hubs that hold the named profiles.
The printed `--keep-local` names that hub's profiles, so it reads no other
hub. When a pull with names leaves another hub's pin as it is, it warns
and prints the same two ways out; since it listed none of that hub's
files, it says to run the `--keep-local` with `--dry-run` first. `--dry-run` lists the conflict and writes
nothing. `sync push` also
refuses to replace a hub's pin that moved since this host last pulled it:
pull first.

A profile follows the pin of its own hub (`sync.hub`, else `default`).
`pi-profile run` compares that pin with the Pi it launches, the first `pi`
on `PATH`. On a mismatch it prints one warning and launches Pi anyway; it
never refuses because of the pin. `doctor` reports the mismatch. Neither
reads the hub: they use the pin this host last set, pulled or pushed.

`run`, `doctor`, `sync pull` and `enrol` never install Pi. `pi-profile pin --install`
does, and prints the exact command before it runs it. It works only when Pi
is an npm global install: it runs
`npm install --global --prefix PREFIX '@earendil-works/pi-coding-agent@PIN'`
into the same prefix. A Pi from the pi.dev installer (a managed install)
can only update to the latest release, and pi-profile never edits its
files, so `--install` refuses it with exit 2 and prints the npm command you
can run instead.

A hub with a pin has `"schemaVersion": 2` in `hub.json`. A pi-profile
older than the pin refuses such a hub (`hub.json must be ...`), so upgrade
pi-profile on every host before you set a pin. Without a pin, `hub.json`
stays schema 1.

### Enrol another host

`enrol` sets up another of your hosts from this one, over SSH:

```sh
pi-profile enrol good-kiwi-laptop                       # hub default, as this host has it
pi-profile enrol good-kiwi-laptop --session-store /srv/pi/sessions --auth pull
pi-profile enrol good-kiwi-laptop --dry-run             # print what it would do
```

It runs these steps on `HOST`, a Tailscale short name:

1. Check that the PATH `ssh HOST` runs has Node 24 or later, Pi and
   pi-profile. It never installs them. When one is missing or too old, it
   prints the command to run on `HOST` and stops with exit 2 before anything
   is written there.
2. Write machine config there: `hostId` (that host's own default, the
   Tailscale short name, unless `--host-id`) and, with `--session-store
   PATH`, a session store `main` set as the default.
3. `sync init` there, with the hub's remote: this host's remote for the hub
   (`--hub NAME`, default `default`), or `--remote`. A remote that is a
   local path here is not one `HOST` can reach, so `enrol` refuses it and
   names the way out: `--remote THISHOST:PATH`.
4. `sync pull` there, the normal way: never `--theirs`, `--keep-local` or
   `--install-packages`. A refused pull stops `enrol` with exit 2 and the
   command to run on `HOST`.
5. Compare the Pi there with the hub's Pi version pin. A mismatch is a
   warning; enrolment goes on.

Then it prints the `shell-init` line for `HOST`'s login shell, or all three
when that shell is not fish, bash or zsh.

When `HOST`'s own default host ID is not a safe name (for example a
Tailscale name with an `_`), `enrol` stops with exit 2 and asks for
`--host-id`; run it again with `--host-id NAME`.

`--dry-run` writes nothing to machine config, profiles, sync state or the
mirror's `main` on either host. On a host that is already enrolled it
fetches the hub into that host's mirror, as `sync pull --dry-run` does, to
know what the pull would change.

Run it again at any time: a step already in place is reported as
`already` and nothing changes. `enrol` never changes what it finds: a
machine config with another `hostId` or default session store, or a hub
that uses another remote, is refused with exit 2 and the way out.

`enrol` never copies a credential. With `--auth pull`, after the pull it
runs `pi-profile auth pull THISHOST --profile P` on `HOST` for each profile
the pull brought, so `HOST` fetches the logins from this host through the
usual `auth` commands (see [Moving credentials between
devices](#moving-credentials-between-devices)). `HOST` must reach this host
over SSH for that. When it cannot, `enrol` exits 1 and prints the commands
to run instead: `auth pull` on `HOST`, or `auth push HOST` from here.

Every word `enrol` sends to `HOST` is a fixed word or a checked value, so a
remote shell reads nothing as code. A remote or path with a space, a quote or
a shell character is refused. When ssh fails, `enrol` prints ssh's last error
line. For `Host key verification failed`, connect once with `ssh HOST` to
accept the key, then run `enrol` again.

## The sync manifest

pi-profile decides what config sync may carry. Each path in a profile has one
class:

| Class | Paths | May ride |
|---|---|---|
| `config` | `profile.json`, `settings.json`, `AGENTS.md`, `models.json`, `pi-multi-account/config.json`, known extension configs such as `acp.json`, `fabric.json`, `web-search.json`, `context-aware.json`, and text files in `skills/` and `prompts/` | config sync |
| `secret` | credential names wherever they appear: `auth*.json` and its backups, `.env*`, `netrc`, `npmrc`, `pypirc`, `pgpass`, `htpasswd` and `s3cfg` with any suffix (`netrc.conf`), `token*`, `password*` and `api-key*` names (`token.txt`), `id_*` keys, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*credential*`, `*token*.json`, `cookies*`, `kubeconfig`, `service-account*.json`, gh `hosts.yml`, and the whole of `.ssh/`, `.aws/`, `.gnupg/`, `.docker/`, `.kube/` | `pi-profile auth` only |
| `sessions` | `sessions/`, and a `sessionDir` inside the profile | backups |
| `state` | caches, `npm/`, `bin/`, `install/`, registries, `*.log`, `*.bak*`, `trust.json`, `models-store.json` | nothing; stays on this host |
| `unknown` | everything else | nothing; stays on this host |

A name is tested for a credential after NFKC normalisation, in lower case,
without a leading dot and without a trailing `~`, `.swp`, `.swo`, space or
dot, so `auth.json~` and `.auth.json.swp` are secrets too. These paths are
`unknown`, never `config`, and the reason is shown:

- a link, unless its name is a secret: a link is never followed;
- a config file with more than one hard link;
- a name with a character outside printable ASCII (a look-alike such as a
  Cyrillic `а`, or an invisible one such as U+200B), or a leading or trailing
  space, or a trailing dot;
- a file in `skills/` or `prompts/` that is not one of these text types:
  `.md`, `.markdown`, `.mdx`, `.txt`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`,
  `.cjs`, `.json`, `.jsonc`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.ini`,
  `.cfg`, `.conf`, `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.py`, `.go`,
  `.rs`, `.rb`, `.lua`, `.sql`, `.bend`, `.tmpl`, `.html`, `.css`, `.svg`,
  `.xml`, `.csv`; and not one of these names: `README`, `LICENSE`,
  `Makefile`, `Dockerfile`, `.gitignore`, `.gitkeep`, `bend-version`,
  `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`. A file with no type is
  allowed only when it starts with `#!` and is valid UTF-8 text; it is then
  scanned like any other. `.env*` stays secret. `include` cannot override
  this.

`pi-profile sync status [NAME] [--json]` prints the count of each class and
lists unknown paths (with the reason), links, and the config files config
sync would skip, each with its reason and the locations of its
credential-looking values. It never prints file contents or values.
`pi-profile doctor` warns about the same unknown paths and skipped files,
about each `sync.allowFindings` entry it ignores, and about each "stale allow
entry" that matches no finding (by path, line and key only).

A refused file is refused alone: `sync push` skips it, lists it,
and still carries every other config file (`pushPlan`). A path never
downgrades a finding; `tests/` and `fixtures/` are scanned like any other
folder.

The credential scan reads every config file up to 1 MiB. JSON is checked by
key path; other text line by line. It reports a location (`providers.x.apiKey`
or `line 3`), never the value, and every finding on a line. It flags:

- a value of a known shape anywhere: `sk-…`, `ghp_…`/`gho_…`/`github_pat_…`,
  `xoxb-…`, `AKIA…`, a JWT (`eyJ….….…`), `Bearer <token>`, `Basic <base64>`,
  `user:password@` in a URL, or a PEM private key; in JSON that parses, also
  in a key name;
- in JSON that parses, a key that repeats a key of its object: `JSON.parse`
  keeps only the last value, but the file still holds the others, so the
  file is refused (`duplicate-key`, a hard finding);
- a string or number under a credential key, also inside an object or list
  below it. A key is a credential key when it ends in `password`, `passwd`,
  `secret`, `token`, `apiKey`, `accessKey`, `privateKey`, `credential`,
  `authorization`, `bearer` or `cookie` (or a plural), or is exactly
  `pass`, `pwd`, `auth` or `sessionId`. `pass`, `pwd` and `auth` also count
  as the last word (`DB_PASS`, `MYSQL_PWD`, `redis_auth`) when the value
  looks like a secret, and so does `PASSWORD` at the end of a capital word
  (`PGPASSWORD`). In code, a `…Key` or `…_key` with a quoted, secret-like
  value counts (`openaiKey = "…"`). Case and camel, snake or kebab form
  do not matter: `API_KEY`, `api-key`, `session_id`. In settings files
  (JSON, YAML, TOML, shell, INI) a key ending in `key`, `access` or `refresh`
  counts too. Keys about amounts, such as `maxTokens`, are skipped. A map
  key directly below a credential key may itself be the secret, so it is
  listed as `*` (`tokens.*`), never by name.

Every text file is checked by key, including code and Markdown, and a JSON
file that does not parse. A key is found anywhere in a line, in these forms:
`key = "…"`, `key: "…"`, `key: value`, `KEY='…'`, `"key": "…"`,
`export KEY=…`, `key := "…"` and `--key=…`. Outside settings files the scan
keeps false alarms low:

- in a code file (`.ts`, `.js`, `.py`, `.go` and the like) only a string
  literal counts; an identifier, call or expression such as
  `process.env.API_KEY`, `os.getenv("X")` or `readToken()` does not;
- in prose, `key: value` counts only when nothing but a comment follows the
  value, so `Token: see below` does not;
- the value must look like a secret: no spaces, at least 6 characters, and a
  digit or at least 10 characters, and not a name of joined words such as
  `session-main`;
- a placeholder (`<your-api-key>`, `…`, `your-key`) does not count, nor does
  a value of one repeated character (`xxxx`, `0000`, a nil UUID);
- a quoted `Basic …` or `Bearer …` value is checked without its scheme, and
  a quoted value under a password or passphrase key may hold spaces;
- after a YAML block marker (`|`, `>-`) or an opening `"""`, the next
  non-empty line is the value.

A value counts as a reference, not a credential, only in these forms:
`${VAR}`, `$VAR`, `env:VAR` and `!command`. A bare name such as
`OPENAI_API_KEY` is a literal and is flagged.

The scan is a second line of defence; the path class is the boundary. It
knowingly misses: `password hunter2x` (a space as the separator), XML
elements such as `<password>…</password>`, `curl -u user:password`, CSV
fields, Markdown table rows, inline-code spans, prose after a value
(`password: hunter2 for prod`), and 6-9 character passwords with no digit
outside settings files.

To let a value you checked is not a secret ride, run
`pi-profile sync status [NAME] --allow-line PATH:LINE`. It prints the entry
to add, one for each finding on the line, with a random salt and a salted
scrypt digest of the line, never the line:

```json
"sync": { "allowFindings": [{ "path": "skills/s/x.ts", "line": 12, "key": "token", "salt": "…", "scrypt": "…" }] }
```

An entry allows one finding (one line and key) while its path, line, key and
the digest of that line all match, so any edit to the line flags it again. A
line with two findings needs two entries. The digest is scrypt (N=2^14, r=8,
p=1, 32 bytes) of `pi-profile/allow/v1`, the path, the key and the line,
joined by NUL bytes, with the entry's 16-byte salt: a leftover entry is slow to
guess its line from. The path must be one file, relative and normalised, with
no glob; unknown fields are refused. An old entry with a `sha256` field is
refused: regenerate it with `--allow-line`.

A hard shape (`sk-…`, `ghp_…`, `AKIA…`, a JWT, a private key, `Basic …`,
URL userinfo with a real-looking password, a duplicate JSON key) can never be
allowed, and nor can any other finding on its line: `--allow-line` refuses
it, and `sync status` and `doctor` report an entry on such a line as ignored.
Two shapes are soft and can be allowed: `Bearer <token>` (`bearer`), and
URL userinfo whose password only stands in for one (`url-userinfo-example`):
`pass`, `password`, `passwd`, `pw`, `secret`, `changeme` in any case, a run
of `x` or `*`, or `<…>`, `${…}` or `{…}`. Any other password is hard.

To class unknown paths, add `sync` to `profile.json`:

```json
"sync": { "include": ["memory/**"], "exclude": ["skills/big-model"] }
```

- `include` makes an unknown path `config`. It cannot change any other class:
  a secret stays secret and sessions stay sessions.
- `exclude` makes a path `state`, except a secret or sessions path.
- Patterns are relative to the profile, use `/`, and may use `*` (inside one
  segment), `?` and `**` (any number of segments). None of them matches a
  name that starts with a dot; write the dot. A pattern that names a directory
  covers everything below it. Absolute patterns and `..` are refused.
- An `include` pattern must start with a literal name, such as `memory/**`.
  `*`, `**` or `?` in its first segment is refused.

## Development

```sh
bun install --frozen-lockfile   # Bun installs from bun.lock; Node runs the scripts
npm run check            # lint, typecheck, tests with coverage, build, package smoke test
cd model && bend PROOF.bend --check-only   # the Bend domain model
```

The rules the code follows are written as laws in `model/LAWS.bend`; see
`model/README.md`.
