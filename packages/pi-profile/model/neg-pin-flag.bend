# expect-failure: SOME PROOFS FAIL
# Negative control (L25): claims `pin` without --install has the install
# flag. If it checks, installFlag no longer tells the flag apart and
# only_flag_installs passes for an install by `pin` without --install.
import Base
import ./Domain.bend as D

law pin_without_flag_has_flag:
  {D.installFlag(D.Pin{False{}}) == True{} : Bool}

def pin_without_flag_has_flag():
  {==}
