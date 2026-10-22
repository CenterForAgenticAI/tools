# expect-failure: SOME PROOFS FAIL
# Negative control (L26): on equal write times the receiver always keeps its own
# copy, even when the incoming one expires later.
# same_write_later_expiry_wins must reject it.
import Base
import ./Lib.bend as L

def keepOnSameWrite(+lw: Nat, le: Nat, +iw: Nat, ie: Nat) -> Bool:
  Bool.pick(Bool, L.ltN(lw, iw), True{}, False{})

law same_write_later_expiry_wins:
  for +w: Nat
  for +le: Nat
  for +ie: Nat
  {keepOnSameWrite(w, le, w, ie) == L.ltN(le, ie) : Bool}

def same_write_later_expiry_wins(w, le, ie):
  match w:
    case 0n:
      {==}
    case 1n+p:
      same_write_later_expiry_wins(p, le, ie)
