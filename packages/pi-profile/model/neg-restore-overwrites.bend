# expect-failure: SOME PROOFS FAIL
# Negative control (L28): a restore that always replaces the stub, so lines
# added to it after archiving are lost. restore_keeps_grown_stub must reject
# it.
import Base
import ./Domain.bend as D

def alwaysReplace(added: Nat) -> D.Restore:
  D.ReplaceStub{}

law restore_keeps_grown_stub:
  for +n: Nat
  {D.overwritesStub(alwaysReplace(1n+n)) == False{} : Bool}

def restore_keeps_grown_stub(n):
  {==}
