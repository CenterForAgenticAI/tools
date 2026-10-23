# expect-failure: SOME PROOFS FAIL
# Negative control (L30): every profile syncs, as if a separate profile that is
# not the default shared its logins the way the default does.
# named_push_follows_mode must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def everyone(k: D.ProfileKind, m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  D.pushesCred(pushKeys, c)

law named_push_follows_mode:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {everyone(D.NamedProfile{}, N.Separate{}, f, s, D.OAuth{e}) == D.autoPush(N.Separate{}, f, s, D.OAuth{e}) : Bool}

def named_push_follows_mode(f, s, e):
  {==}
