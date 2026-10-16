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

# L20: API keys are never pushed automatically, in any mode.
law api_keys_never_auto_pushed:
  for +m: N.AuthMode
  for +k: Nat
  {D.autoPush(m, D.ApiKey{k}) == False{} : Bool}

# L21: only pooled mode pushes anything automatically.
law shared_never_auto_pushes:
  for +c: D.Cred
  {D.autoPush(N.Shared{}, c) == False{} : Bool}

law separate_never_auto_pushes:
  for +c: D.Cred
  {D.autoPush(N.Separate{}, c) == False{} : Bool}

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
