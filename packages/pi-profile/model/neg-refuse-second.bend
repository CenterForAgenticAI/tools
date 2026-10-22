# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan whose Refuse comes second does not
# refuse. If it checks, refuses reads only the first step, and
# run_never_refuses_on_pin passes for a `run` that warns and then refuses.
import Base
import ./Domain.bend as D

law refuse_second_not_seen:
  {D.refuses([D.Warn{}, D.Refuse{}]) == False{} : Bool}

def refuse_second_not_seen():
  {==}
