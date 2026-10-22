# expect-failure: SOME PROOFS FAIL
# Negative control (L21): the old rule, where only pooled profiles push. A
# shared profile then never pushes a refreshed login, and
# shared_pushes_logins must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def pooledOnly(m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match m:
    case N.Shared{}:
      False{}
    case N.Separate{}:
      False{}
    case N.Pooled{}:
      D.pushesCred(pushKeys, c)

law shared_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {pooledOnly(N.Shared{}, f, s, D.OAuth{e}) == True{} : Bool}

def shared_pushes_logins(f, s, e):
  {==}
