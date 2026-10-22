# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a plan whose Warn comes second does not warn.
# If it checks, warns reads only the first step, and run_mismatch_warns
# passes for a `run` that launches Pi before it warns.
import Base
import ./Domain.bend as D

law warn_second_not_seen:
  {D.warns([D.Launch{}, D.Warn{}]) == False{} : Bool}

def warn_second_not_seen():
  {==}
