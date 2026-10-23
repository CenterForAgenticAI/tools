import Base
import ./Lib.bend as L
import ./Enums.bend as N
import ./Domain.bend as D
import ./LAWS.bend as Laws

def Laws.explicit_profile_wins(e, x, g, ng):
  {==}

def Laws.exported_beats_global(x, g, ng):
  {==}

def Laws.no_global_default_honoured(x, g):
  match x:
    case D.NoVal{}:
      {==}
    case D.Val{v}:
      {==}

def Laws.session_flag_wins(f, env, s, d):
  {==}

def Laws.session_default_is_profile(d):
  {==}

def Laws.backup_target_writable(h):
  L.nat_eq_refl(h)

def Laws.fork_owned_locally(h, s):
  match s:
    case D.Sess{o, g}:
      {==}

def Laws.secrets_never_backed_up(k):
  {==}

def Laws.secrets_never_config_synced():
  {==}

def Laws.state_stays_local(ch):
  {==}

def Laws.unknown_stays_local(ch):
  {==}

def Laws.no_secret_to_third_party(c, ch):
  match c ch:
    case N.ConfigPath{} D.ConfigSync{}:
      {==}
    case N.ConfigPath{} D.Backup{k}:
      {==}
    case N.ConfigPath{} D.AuthTransfer{}:
      {==}
    case N.StatePath{} D.ConfigSync{}:
      {==}
    case N.StatePath{} D.Backup{k}:
      {==}
    case N.StatePath{} D.AuthTransfer{}:
      {==}
    case N.SecretPath{} D.ConfigSync{}:
      {==}
    case N.SecretPath{} D.Backup{k}:
      {==}
    case N.SecretPath{} D.AuthTransfer{}:
      {==}
    case N.SessionsPath{} D.ConfigSync{}:
      {==}
    case N.SessionsPath{} D.Backup{k}:
      {==}
    case N.SessionsPath{} D.AuthTransfer{}:
      {==}
    case N.UnknownPath{} D.ConfigSync{}:
      {==}
    case N.UnknownPath{} D.Backup{k}:
      {==}
    case N.UnknownPath{} D.AuthTransfer{}:
      {==}

def Laws.s3_encrypts_by_default():
  {==}

def Laws.encrypt_override_wins(k, b):
  {==}

def Laws.shared_mode_shares(p):
  {==}

def Laws.separate_mode_isolates(p):
  {==}

def Laws.api_key_kept_without_force(a, i):
  match i:
    case D.ApiKey{b}:
      {==}
    case D.OAuth{e}:
      {==}

def Laws.oauth_not_replaced_by_key(e, b):
  {==}

def Laws.force_takes_incoming(l, i):
  {==}

def Laws.api_keys_pushed_only_with_flag(m, s, k):
  match m:
    case N.Shared{}:
      {==}
    case N.Separate{}:
      {==}
    case N.Pooled{}:
      {==}

def Laws.shared_pushes_logins(f, s, e):
  {==}

def Laws.pooled_pushes_logins(f, s, e):
  {==}

def Laws.separate_never_auto_pushes(f, s, c):
  {==}

def Laws.default_syncs_on_its_own(m):
  {==}

def Laws.default_pushes_logins(m, f, s, e):
  {==}

def Laws.default_keys_need_flag(m, s, k):
  {==}

def Laws.named_separate_never_syncs():
  {==}

def Laws.named_push_follows_mode(m, f, s, c):
  match m:
    case N.Shared{}:
      {==}
    case N.Separate{}:
      {==}
    case N.Pooled{}:
      {==}

# Lemma for L26: no number is before itself.
law lt_irrefl:
  for n: Nat
  {L.ltN(n, n) == False{} : Bool}

def lt_irrefl(n):
  match n:
    case 0n:
      {==}
    case 1n+p:
      lt_irrefl(p)

# Each L26 proof walks both write times down together; ltN(1+p, 1+q) is
# ltN(p, q), so takeIncoming on the successors is takeIncoming on p and q.
def Laws.newer_login_taken(lw, le, iw, ie, h):
  match lw iw:
    case 0n 0n:
      Empty.absurd({D.takeIncoming(0n, le, 0n, ie) == True{} : Bool}, h)
    case 0n 1n+q:
      {==}
    case 1n+p 0n:
      Empty.absurd({D.takeIncoming(1n+p, le, 0n, ie) == True{} : Bool}, h)
    case 1n+p 1n+q:
      Laws.newer_login_taken(p, le, q, ie, h)

def Laws.older_login_kept(lw, le, iw, ie, h):
  match lw iw:
    case 0n 0n:
      Empty.absurd({D.takeIncoming(0n, le, 0n, ie) == False{} : Bool}, h)
    case 0n 1n+q:
      Empty.absurd({D.takeIncoming(0n, le, 1n+q, ie) == False{} : Bool}, h)
    case 1n+p 0n:
      {==}
    case 1n+p 1n+q:
      Laws.older_login_kept(p, le, q, ie, h)

def Laws.same_write_later_expiry_wins(w, le, ie):
  match w:
    case 0n:
      {==}
    case 1n+p:
      Laws.same_write_later_expiry_wins(p, le, ie)

def Laws.full_tie_keeps_local(w, e):
  match w:
    case 0n:
      lt_irrefl(e)
    case 1n+p:
      Laws.full_tie_keeps_local(p, e)

def Laws.unknown_group_refused(c, g):
  {==}

def Laws.group_keeps_other_keys(c, g):
  match c:
    case D.MaCfg{gs, d, o}:
      {==}

def Laws.group_keeps_groups(c, g):
  match c:
    case D.MaCfg{gs, d, o}:
      {==}

def Laws.run_never_refuses_on_pin(p):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.run_mismatch_warns():
  {==}

def Laws.run_always_launches(p):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.run_passes_pi_exit(p, x):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.only_flag_installs(c, p):
  match c:
    case D.Run{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Doctor{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Enrol{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Pin{i}:
      match i:
        case False{}:
          {==}
        case True{}:
          match p:
            case D.NoPin{}:
              {==}
            case D.PinMatches{}:
              {==}
            case D.PinMismatch{}:
              {==}
            case D.PinUnknown{}:
              {==}
    case D.SyncPull{i}:
      match i:
        case False{}:
          {==}
        case True{}:
          {==}

def Laws.run_never_installs(p):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.doctor_never_installs(p):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.pin_without_flag_never_installs(p):
  {==}

def Laws.sync_pull_without_flag_never_installs(p):
  {==}

def Laws.enrol_never_installs(p):
  match p:
    case D.NoPin{}:
      {==}
    case D.PinMatches{}:
      {==}
    case D.PinMismatch{}:
      {==}
    case D.PinUnknown{}:
      {==}

def Laws.install_shown_first(c, p):
  match c:
    case D.Run{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Doctor{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Enrol{}:
      match p:
        case D.NoPin{}:
          {==}
        case D.PinMatches{}:
          {==}
        case D.PinMismatch{}:
          {==}
        case D.PinUnknown{}:
          {==}
    case D.Pin{i}:
      match i:
        case False{}:
          {==}
        case True{}:
          match p:
            case D.NoPin{}:
              {==}
            case D.PinMatches{}:
              {==}
            case D.PinMismatch{}:
              {==}
            case D.PinUnknown{}:
              {==}
    case D.SyncPull{i}:
      match i:
        case False{}:
          {==}
        case True{}:
          {==}

def Laws.archive_verifies_before_removing(d, c):
  match d:
    case True{}:
      {==}
    case False{}:
      match c:
        case D.CopyMatches{}:
          {==}
        case D.CopyDiffers{}:
          {==}
        case D.CopyMissing{}:
          {==}

def Laws.archive_keeps_unverified(d, c):
  match d:
    case True{}:
      match c:
        case D.CopyMatches{}:
          {==}
        case D.CopyDiffers{}:
          {==}
        case D.CopyMissing{}:
          {==}
    case False{}:
      match c:
        case D.CopyMatches{}:
          {==}
        case D.CopyDiffers{}:
          {==}
        case D.CopyMissing{}:
          {==}

def Laws.restore_keeps_grown_stub(n):
  {==}

def Laws.archive_dry_run_changes_nothing(c):
  {==}
