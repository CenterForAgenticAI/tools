# expect-failure: SOME PROOFS FAIL
# Negative control (L20): a shared profile that pushes API keys whether or not
# its flag is on. api_keys_pushed_only_with_flag must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def keysAlways(m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match m:
    case N.Shared{}:
      True{}
    case N.Separate{}:
      False{}
    case N.Pooled{}:
      D.pushesCred(pushKeys, c)

law api_keys_pushed_only_with_flag:
  for +m: N.AuthMode
  for +s: D.LoginSource
  for +k: Nat
  {keysAlways(m, False{}, s, D.ApiKey{k}) == False{} : Bool}

def api_keys_pushed_only_with_flag(m, s, k):
  match m:
    case N.Shared{}:
      {==}
    case N.Separate{}:
      {==}
    case N.Pooled{}:
      {==}
