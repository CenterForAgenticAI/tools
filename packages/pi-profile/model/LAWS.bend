# Laws of pi-profile. Human-owned: change only with approval, then update
# laws.sha256. Each law cites the decision in ../.spec/design.md it encodes.
import Base
import ./Lib.bend as L
import ./Enums.bend as N
import ./Domain.bend as D

# ---------------------------------------------------------------- profile selection

# L1: an explicit profile (`run NAME`, --profile) always wins.
law explicit_profile_wins:
  for +e: Nat
  for +x: D.Opt
  for +g: D.Opt
  for +ng: Bool
  {D.selectSource(D.Val{e}, x, g, ng) == D.Explicit{} : D.Source}

# L2: an exported PI_CODING_AGENT_DIR beats the global default.
law exported_beats_global:
  for +x: Nat
  for +g: D.Opt
  for +ng: Bool
  {D.selectSource(D.NoVal{}, D.Val{x}, g, ng) == D.Exported{} : D.Source}

# L3: PI_PROFILE_NO_GLOBAL_DEFAULT means the global default is never used.
law no_global_default_honoured:
  for +x: D.Opt
  for +g: D.Opt
  {D.isGlobal(D.selectSource(D.NoVal{}, x, g, True{})) == False{} : Bool}

# ---------------------------------------------------------------- session storage

# L4: --session-dir overrides every other session-directory source.
law session_flag_wins:
  for +f: Nat
  for +env: D.Opt
  for +s: D.Opt
  for +d: Nat
  {D.sessionDir(D.Val{f}, env, s, d) == f : Nat}

# L5: with nothing configured, sessions stay in the profile directory.
law session_default_is_profile:
  for +d: Nat
  {D.sessionDir(D.NoVal{}, D.NoVal{}, D.NoVal{}, d) == d : Nat}

# ---------------------------------------------------------------- repositories

# L6: a host's backup target is a subtree that host may write.
law backup_target_writable:
  for +h: Nat
  {D.writable(h, D.backupTarget(h)) == True{} : Bool}

# L7: continuing another host's session yields a session the local host owns.
law fork_owned_locally:
  for +h: Nat
  for +s: D.Sess
  {D.sessOwner(D.fork(h, s)) == h : Nat}

# ---------------------------------------------------------------- what may move where

# L8: secrets never ride a backup, whatever the replica kind.
law secrets_never_backed_up:
  for +k: N.ReplicaKind
  {D.mayCarry(N.SecretPath{}, D.Backup{k}) == False{} : Bool}

# L9: secrets never ride config sync.
law secrets_never_config_synced:
  {D.mayCarry(N.SecretPath{}, D.ConfigSync{}) == False{} : Bool}

# L10: machine-local state never leaves the host.
law state_stays_local:
  for +ch: D.Channel
  {D.mayCarry(N.StatePath{}, ch) == False{} : Bool}

# L11: deny by default - an unclassified path never leaves the host.
law unknown_stays_local:
  for +ch: D.Channel
  {D.mayCarry(N.UnknownPath{}, ch) == False{} : Bool}

# L12: no channel carries a secret to a third party.
law no_secret_to_third_party:
  for +c: N.PathClass
  for +ch: D.Channel
  {Bool.and(D.mayCarry(c, ch), Bool.and(D.isSecret(c), D.isThirdParty(D.reach(ch)))) == False{} : Bool}

# ---------------------------------------------------------------- encryption

# L13: an S3 replica encrypts unless told otherwise.
law s3_encrypts_by_default:
  {D.encrypts(N.S3Replica{}, D.Inherit{}) == True{} : Bool}

# L14: an explicit `encrypt` setting beats the kind's default.
law encrypt_override_wins:
  for +k: N.ReplicaKind
  for +b: Bool
  {D.encrypts(k, D.Force{b}) == b : Bool}

# ---------------------------------------------------------------- auth

# L15: shared mode uses the one shared auth.json.
law shared_mode_shares:
  for +p: Nat
  {D.authFile(N.Shared{}, p) == D.SharedAuth{} : D.AuthFile}

# L16: separate mode uses the profile's own auth.json.
law separate_mode_isolates:
  for +p: Nat
  {D.authFile(N.Separate{}, p) == D.ProfileAuth{p} : D.AuthFile}

# L17: without --force, a local API key is never replaced.
law api_key_kept_without_force:
  for +a: Nat
  for +i: D.Cred
  {D.merge(D.ApiKey{a}, i, False{}) == D.ApiKey{a} : D.Cred}

# L18: without --force, an API key never replaces a local OAuth login.
law oauth_not_replaced_by_key:
  for +e: Nat
  for +b: Nat
  {D.merge(D.OAuth{e}, D.ApiKey{b}, False{}) == D.OAuth{e} : D.Cred}

# L19: --force takes the incoming entry.
law force_takes_incoming:
  for +l: D.Cred
  for +i: D.Cred
  {D.merge(l, i, True{}) == i : D.Cred}

# L20 and L21 changed, and L26 added, as proposed on 2026-10-21 (decisions on
# issue 67); pending review. autoPush(mode, pushKeys, source, entry): pushKeys
# is the profile's flag for pushing API keys; source says whether this machine
# ran /login for the entry or received it from a peer.

# L20: without the profile's flag for it, an API key is never pushed
# automatically, in any mode.
law api_keys_pushed_only_with_flag:
  for +m: N.AuthMode
  for +s: D.LoginSource
  for +k: Nat
  {D.autoPush(m, False{}, s, D.ApiKey{k}) == False{} : Bool}

# L21: any machine may refresh a shared login and push it. A shared or pooled
# profile pushes a changed OAuth login whether this machine logged in or
# received the login from a peer: no machine owns a login. A separate profile
# never pushes.
law shared_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {D.autoPush(N.Shared{}, f, s, D.OAuth{e}) == True{} : Bool}

law pooled_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {D.autoPush(N.Pooled{}, f, s, D.OAuth{e}) == True{} : Bool}

law separate_never_auto_pushes:
  for +f: Bool
  for +s: D.LoginSource
  for +c: D.Cred
  {D.autoPush(N.Separate{}, f, s, c) == False{} : Bool}

# L26, rewritten on 2026-10-21 (Chris's decision on issue 67): the newest
# login wins. A push or merge without --force takes the incoming OAuth login
# when it was written later than the local copy, whatever either expiry says.
# When the write times are equal, the later expiry wins; a full tie keeps the
# local copy. Automatic pushes never pass --force, and --force still takes the
# incoming entry (L19). In takeIncoming(lw, le, iw, ie), lw and iw are when
# the local and incoming copies were written, le and ie when they expire. The
# code follows in the auth change.
law newer_login_taken:
  for +lw: Nat
  for +le: Nat
  for +iw: Nat
  for +ie: Nat
  for h: L.T(L.ltN(lw, iw))
  {D.takeIncoming(lw, le, iw, ie) == True{} : Bool}

law older_login_kept:
  for +lw: Nat
  for +le: Nat
  for +iw: Nat
  for +ie: Nat
  for h: L.T(L.ltN(iw, lw))
  {D.takeIncoming(lw, le, iw, ie) == False{} : Bool}

law same_write_later_expiry_wins:
  for +w: Nat
  for +le: Nat
  for +ie: Nat
  {D.takeIncoming(w, le, w, ie) == L.ltN(le, ie) : Bool}

law full_tie_keeps_local:
  for +w: Nat
  for +e: Nat
  {D.takeIncoming(w, e, w, e) == False{} : Bool}

# ---------------------------------------------------------------- pi-multi-account

# L22: an undefined account group is refused, not written.
law unknown_group_refused:
  for +c: D.MaCfg
  for +g: Nat
  {D.applyGroup(False{}, c, g) == D.Refused{} : D.Applied}

# L23: setting the default group leaves every other key alone.
law group_keeps_other_keys:
  for +c: D.MaCfg
  for +g: Nat
  {D.maOther(D.setDefault(c, g)) == D.maOther(c) : Nat}

law group_keeps_groups:
  for +c: D.MaCfg
  for +g: Nat
  {D.maGroups(D.setDefault(c, g)) == D.maGroups(c) : Nat}

# ---------------------------------------------------------------- the Pi version pin and installs
# L24 and L25 approved by the user on 2026-10-11 (intel/pi-profile#58).

# L24: `run` never refuses because of the Pi version pin. A mismatch between
# the pin and the installed Pi only warns; `run` still launches Pi and passes
# its exit code through.
law run_never_refuses_on_pin:
  for +p: D.PinCheck
  {D.refuses(D.plan(D.Run{}, p)) == False{} : Bool}

law run_mismatch_warns:
  {D.warns(D.plan(D.Run{}, D.PinMismatch{})) == True{} : Bool}

law run_always_launches:
  for +p: D.PinCheck
  {D.launches(D.plan(D.Run{}, p)) == True{} : Bool}

# x is the status Pi exits with; `run` exits with x for every pin check.
law run_passes_pi_exit:
  for +p: D.PinCheck
  for +x: Nat
  {D.exitCode(D.plan(D.Run{}, p), x) == x : Nat}

# L25: only an explicit install flag installs software. Today the flags are
# `pi-profile pin --install` and `pi-profile sync pull --install-packages`.
# `run`, `doctor`, `sync pull` without the flag, and `enrol` never install
# anything. An install prints the exact command before it runs it.
law only_flag_installs:
  for +c: D.Command
  for +p: D.PinCheck
  {Bool.and(D.installs(D.plan(c, p)), Bool.not(D.installFlag(c))) == False{} : Bool}

law run_never_installs:
  for +p: D.PinCheck
  {D.installs(D.plan(D.Run{}, p)) == False{} : Bool}

law doctor_never_installs:
  for +p: D.PinCheck
  {D.installs(D.plan(D.Doctor{}, p)) == False{} : Bool}

law pin_without_flag_never_installs:
  for +p: D.PinCheck
  {D.installs(D.plan(D.Pin{False{}}, p)) == False{} : Bool}

law sync_pull_without_flag_never_installs:
  for +p: D.PinCheck
  {D.installs(D.plan(D.SyncPull{False{}}, p)) == False{} : Bool}

law enrol_never_installs:
  for +p: D.PinCheck
  {D.installs(D.plan(D.Enrol{}, p)) == False{} : Bool}

law install_shown_first:
  for +c: D.Command
  for +p: D.PinCheck
  {D.showsFirst(D.plan(c, p)) == True{} : Bool}

# ---------------------------------------------------------------- the session archive
# L27-L29 proposed on 2026-10-21 (decisions on issue 64); pending review.

# L27: an archive never deletes or stubs a session before its compressed copy
# is verified on the target, and never removes a session whose copy did not
# verify.
law archive_verifies_before_removing:
  for +d: Bool
  for +c: D.CopyCheck
  {D.verifiedFirst(D.archivePlan(d, c)) == True{} : Bool}

law archive_keeps_unverified:
  for +d: Bool
  for +c: D.CopyCheck
  {Bool.and(D.removes(D.archivePlan(d, c)), Bool.not(D.copyMatches(c))) == False{} : Bool}

# L28: a restore never overwrites a stub that has had lines added after
# archiving; it keeps both copies.
law restore_keeps_grown_stub:
  for +n: Nat
  {D.overwritesStub(D.restoreAct(1n+n)) == False{} : Bool}

# L29: an archive dry run changes nothing.
law archive_dry_run_changes_nothing:
  for +c: D.CopyCheck
  {D.changes(D.archivePlan(True{}, c)) == False{} : Bool}
