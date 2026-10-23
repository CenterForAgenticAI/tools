# pi-profile model

A compiled model of the rules in `../.spec/design.md`. The Bend type checker
proves each rule in `LAWS.bend` against the definitions in `Domain.bend`.

```text
Model status: approved (L1-L25 as first approved; L20, L21 changed and
              L26-L29 added on this revision as a proposal, pending review;
              L30 added, and L21 given a pointer to it, as a further
              proposal of 2026-10-23, pending review)
Source revision: 38a8a46 (the code L24-L25 were checked against; L1-L23 were
                 written from .spec/design.md draft v1, 2026-10-01)
Approved revision: LAWS.bend sha256 70a6f7b727cc066cd75e378493c31f5b46516b81ef35538d809591f1b9bcc56a
                   (laws.sha256): the initial laws of 711c914 plus L24-L25 from
                   MR 35
Approval record: The maintainer accepted the initial model in conversation, 2026-10-01;
                 L24-L25 approved by the user on 2026-10-11 (issue 58);
                 run_passes_pi_exit and pin_without_flag_never_installs state
                 that approved text and were added in review round 2 of
                 MR 35;
                 the L20, L21 and L26-L29 proposal follows the decisions of
                 2026-10-21 (issues 64 and 67); the L30 proposal follows
                 the maintainer's decision of 2026-10-23 on issue 67 (the default
                 profile syncs logins on its own). laws.sha256 names the proposed
                 LAWS.bend; it counts as approved only once the maintainer merges it
Scope: profile selection precedence; session-directory precedence;
       one-writer repository subtrees and session forks; the sync manifest
       (which path classes may ride config sync, backups, auth transfer);
       replica encryption defaults; auth modes, credential merge (the
       newest login wins, then the later expiry), auto-push (any machine, API keys only
       behind a per-profile flag; the default profile syncs on its own
       although its stored mode is separate); the session archive (verify before
       stubbing, keep a grown stub, a dry run changes nothing);
       pi-multi-account group writes; the Pi version pin at `run` (warn,
       never refuse, pass Pi's exit code through); which commands may
       install software.
```

## Files

| File | What it holds |
|---|---|
| `enums.json` | Spec for the string enums (`AuthMode`, `ReplicaKind`, `PathClass`) |
| `Enums.bend` | Generated from `enums.json`; do not edit by hand |
| `Domain.bend` | The domain: types and the decision functions |
| `LAWS.bend` | The rules (L1-L30). Human-owned |
| `PROOF.bend` | One proof per law |
| `neg-*.bend` | Negative controls: false laws that must fail. `neg-secret-to-s3.bend` guards L8; the pin and install controls guard the helpers L24-L25 rely on, each on a one-step plan and with the matching step second; the others restate one law from L20-L21 or L26-L30 over a broken copy of its decision |
| `Lib.bend` | Shared proof library, copied from the compiled-intent skill |
| `bend-version` | Pinned Bend version |

## Check

```sh
cd model && bend PROOF.bend --check-only
```

`npm run proof` (also run by CI and the pre-commit hook) runs
`scripts/check-model.sh`: the proofs above, then every `neg-*.bend` control,
each of which must fail with the text on its `# expect-failure:` line. It
fails if a control checks or if there are no controls.

The full gate also checks enums, the negative controls and the approval hash:

```sh
node <compiled-intent skill>/bend/gate.mjs model
```

The gate fails until `laws.sha256` exists. Write it only after a person has
read and approved `LAWS.bend`:

```sh
sha256sum model/LAWS.bend | cut -d' ' -f1 > model/laws.sha256
```

## Modelling choices

- Hosts, profiles, paths and keys are `Nat`. The laws are about how they
  relate, so their spelling does not matter.
- An OAuth entry is reduced to its expiry time. L26 states the merge rule
  over `takeIncoming`, which also takes the times the local and incoming
  copies were written: the newer write wins, equal write times fall back to
  the later expiry, and a full tie keeps the local copy. `merge` still
  compares expiries only; the code follows in the auth change.
- The model does not cover file I/O, rsync, ssh or S3. Those are tested in the
  implementation; the model fixes what they are allowed to do.
- A command is reduced to the steps it may take (`Step`: warn, refuse,
  launch, show the install command, install) for each result of the Pi
  version pin check (`PinCheck`). The install flag is a field of the only
  commands that have one (`Pin`, `SyncPull`).
- `exitCode` gives a command's exit status from its steps and the status Pi
  exits with: the first Refuse gives 2, the first Launch gives Pi's status,
  and a command with neither gives 0. The model leaves out the exits that
  happen before the pin check: other failures (exit 1), refusals not caused
  by the pin, such as a profile that does not exist (exit 2), and a `pi` that
  cannot start (exit 127).
- Auto-push takes the profile's flag for API keys and whether this machine
  ran `/login` for the entry or received it from a peer (`LoginSource`). The
  second argument is there so L21 can say that it does not matter: any
  machine may refresh a shared login and push it.
- Which profile a process runs in is reduced to `ProfileKind`: the default
  profile (Pi's own `~/.pi/agent`, which owns the shared `auth.json`) or a
  named one. `syncsOnItsOwn` says whether a profile pushes and pulls on its
  own, and `profilePush` is `autoPush` for a profile of that kind. L30 is a
  new law rather than a change to L21 because L21 still holds as written for
  every mode: the default profile's stored mode stays `separate`, and what
  changes is only that being the default profile overrides the mode.
- An archive run is reduced to its steps for one session (`ArchStep`:
  report, compress, verified, record, stub, delete) for each result of
  reading the copy back from the target (`CopyCheck`). A restore is reduced
  to the number of lines added to the stub after archiving.
