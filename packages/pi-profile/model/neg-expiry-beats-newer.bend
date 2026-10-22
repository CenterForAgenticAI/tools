# expect-failure: SOME PROOFS FAIL
# Negative control (L26): the old rule, where the later expiry always wins. A login
# written later but expiring earlier is refused, so a fresh login from a peer
# never lands. newer_login_taken must reject it.
import Base
import ./Lib.bend as L

def expiryWins(+lw: Nat, le: Nat, +iw: Nat, ie: Nat) -> Bool:
  L.ltN(le, ie)

law newer_login_taken:
  for +lw: Nat
  for +le: Nat
  for +iw: Nat
  for +ie: Nat
  for h: L.T(L.ltN(lw, iw))
  {expiryWins(lw, le, iw, ie) == True{} : Bool}

def newer_login_taken(lw, le, iw, ie, h):
  {==}
