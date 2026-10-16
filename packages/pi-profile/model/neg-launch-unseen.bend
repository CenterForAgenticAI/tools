# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan that only warns launches Pi. If it
# checks, run_always_launches passes for a `run` that warns and stops.
import Base
import ./Domain.bend as D

law warn_only_launches:
  {D.launches([D.Warn{}]) == True{} : Bool}

def warn_only_launches():
  {==}
