# expect-failure: SOME PROOFS FAIL
# Negative control (L30): the old rule, where the default profile follows its
# stored mode like any other profile. Its mode is always separate, so it never
# syncs, and default_pushes_logins must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def byModeOnly(k: D.ProfileKind, m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  D.autoPush(m, pushKeys, s, c)

law default_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {byModeOnly(D.DefaultProfile{}, N.Separate{}, f, s, D.OAuth{e}) == True{} : Bool}

def default_pushes_logins(f, s, e):
  {==}
