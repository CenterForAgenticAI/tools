# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan whose Launch comes second does not
# launch Pi. If it checks, launches reads only the first step, and
# run_always_launches can no longer tell a `run` that warns first from one
# that stops.
import Base
import ./Domain.bend as D

law launch_second_not_seen:
  {D.launches([D.Warn{}, D.Launch{}]) == False{} : Bool}

def launch_second_not_seen():
  {==}
