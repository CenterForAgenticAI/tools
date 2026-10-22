# expect-failure: SOME PROOFS FAIL
# Negative control (L21): a separate profile that pushes its logins like a
# shared one. separate_never_auto_pushes must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def separateToo(m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match m:
    case N.Shared{}:
      D.pushesCred(pushKeys, c)
    case N.Separate{}:
      D.pushesCred(pushKeys, c)
    case N.Pooled{}:
      D.pushesCred(pushKeys, c)

law separate_never_auto_pushes:
  for +f: Bool
  for +s: D.LoginSource
  for +c: D.Cred
  {separateToo(N.Separate{}, f, s, c) == False{} : Bool}

def separate_never_auto_pushes(f, s, c):
  match c:
    case D.ApiKey{k}:
      {==}
    case D.OAuth{e}:
      {==}
