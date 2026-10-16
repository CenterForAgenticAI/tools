# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan that only launches Pi warns. If it
# checks, run_mismatch_warns passes for a `run` that says nothing on a
# mismatch.
import Base
import ./Domain.bend as D

law launch_only_warns:
  {D.warns([D.Launch{}]) == True{} : Bool}

def launch_only_warns():
  {==}
