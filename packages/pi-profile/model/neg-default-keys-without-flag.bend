# expect-failure: SOME PROOFS FAIL
# Negative control (L30): a default profile that pushes API keys whether or
# not its flag is on, because it owns the shared file. default_keys_need_flag
# must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def defaultAll(k: D.ProfileKind, m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match k:
    case D.DefaultProfile{}:
      True{}
    case D.NamedProfile{}:
      D.autoPush(m, pushKeys, s, c)

law default_keys_need_flag:
  for +m: N.AuthMode
  for +s: D.LoginSource
  for +k: Nat
  {defaultAll(D.DefaultProfile{}, m, False{}, s, D.ApiKey{k}) == False{} : Bool}

def default_keys_need_flag(m, s, k):
  {==}
