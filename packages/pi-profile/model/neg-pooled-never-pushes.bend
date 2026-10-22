# expect-failure: SOME PROOFS FAIL
# Negative control (L21): a pooled profile that pushes nothing on its own.
# pooled_pushes_logins must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def sharedOnly(m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match m:
    case N.Shared{}:
      D.pushesCred(pushKeys, c)
    case N.Separate{}:
      False{}
    case N.Pooled{}:
      False{}

law pooled_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {sharedOnly(N.Pooled{}, f, s, D.OAuth{e}) == True{} : Bool}

def pooled_pushes_logins(f, s, e):
  {==}
