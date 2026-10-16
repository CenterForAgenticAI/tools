# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan that refuses does not refuse. If it
# checks, run_never_refuses_on_pin passes for a `run` that refuses.
import Base
import ./Domain.bend as D

law refuse_not_seen:
  {D.refuses([D.Refuse{}]) == False{} : Bool}

def refuse_not_seen():
  {==}
