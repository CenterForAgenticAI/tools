# expect-failure: SOME PROOFS FAIL
# Negative control (L26): on a full tie (same write time, same expiry) the
# receiver takes the incoming copy, so two hosts holding the same login keep
# rewriting each other. full_tie_keeps_local must reject it.
import Base
import ./Lib.bend as L

def tieTakesIncoming(+lw: Nat, le: Nat, +iw: Nat, ie: Nat) -> Bool:
  Bool.pick(Bool, L.ltN(lw, iw), True{}, Bool.pick(Bool, L.ltN(iw, lw), False{}, Bool.not(L.ltN(ie, le))))

law full_tie_keeps_local:
  for +w: Nat
  for +e: Nat
  {tieTakesIncoming(w, e, w, e) == False{} : Bool}

def full_tie_keeps_local(w, e):
  match w:
    case 0n:
      {==}
    case 1n+p:
      full_tie_keeps_local(p, e)
