# expect-failure: SOME PROOFS FAIL
# Negative control (L26): a receiver that ignores an older write time and falls
# back to the expiry, so a stale copy that expires later replaces a newer
# login. older_login_kept must reject it.
import Base
import ./Lib.bend as L

def olderByExpiry(+lw: Nat, le: Nat, +iw: Nat, ie: Nat) -> Bool:
  Bool.pick(Bool, L.ltN(lw, iw), True{}, L.ltN(le, ie))

law older_login_kept:
  for +lw: Nat
  for +le: Nat
  for +iw: Nat
  for +ie: Nat
  for h: L.T(L.ltN(iw, lw))
  {olderByExpiry(lw, le, iw, ie) == False{} : Bool}

def older_login_kept(lw, le, iw, ie, h):
  match lw iw:
    case 0n 0n:
      Empty.absurd({olderByExpiry(0n, le, 0n, ie) == False{} : Bool}, h)
    case 0n 1n+q:
      Empty.absurd({olderByExpiry(0n, le, 1n+q, ie) == False{} : Bool}, h)
    case 1n+p 0n:
      {==}
    case 1n+p 1n+q:
      older_login_kept(p, le, q, ie, h)
