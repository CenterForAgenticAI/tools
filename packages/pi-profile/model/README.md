# pi-profile model

A compiled model of the rules in `../.spec/design.md`. The Bend type checker
proves each rule in `LAWS.bend` against the definitions in `Domain.bend`.

```text
Model status: approved
Source revision: 38a8a46 (the code L24-L25 were checked against; L1-L23 were
                 written from .spec/design.md draft v1, 2026-10-01)
Approved revision: LAWS.bend sha256 70a6f7b727cc066cd75e378493c31f5b46516b81ef35538d809591f1b9bcc56a
                   (laws.sha256): the initial laws of 711c914 plus L24-L25 from
                   MR 35
Approval record: Chris Goddard accepted the initial model in conversation, 2026-10-01;
                 L24-L25 approved by the user on 2026-10-11 (issue 58);
                 run_passes_pi_exit and pin_without_flag_never_installs state
                 that approved text and were added in review round 2 of
                 MR 35
Scope: profile selection precedence; session-directory precedence;
       one-writer repository subtrees and session forks; the sync manifest
       (which path classes may ride config sync, backups, auth transfer);
       replica encryption defaults; auth modes, credential merge, auto-push;
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
| `LAWS.bend` | The rules (L1-L25). Human-owned |
| `PROOF.bend` | One proof per law |
| `neg-*.bend` | Negative controls: false laws that must fail. `neg-secret-to-s3.bend` guards L8; the others guard the helpers L24-L25 rely on |
| `Lib.bend` | Shared proof library, copied from the compiled-intent skill |
| `bend-version` | Pinned Bend version |

## Check

```sh
cd model && bend PROOF.bend --check-only
```

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
- An OAuth entry is reduced to its expiry time. The merge rule only compares
  expiries.
- The model does not cover file I/O, rsync, ssh or S3. Those are tested in the
  implementation; the model fixes what they are allowed to do.
- A command is reduced to the steps it may take (`Step`: warn, refuse,
  launch, show the install command, install) for each result of the Pi
  version pin check (`PinCheck`). The install flag is a field of the only
  commands that have one (`Pin`, `SyncPull`).
- `exitCode` gives a command's exit status from its steps and the status Pi
  exits with: the first Refuse gives 2, the first Launch gives Pi's status,
  and a command with neither gives 0. Other failures (exit 1) are left out.
