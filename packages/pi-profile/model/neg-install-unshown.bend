# expect-failure: SOME PROOFS FAIL
# Negative control (L25): claims an install with no Show before it prints its
# command first. If it checks, install_shown_first passes for a silent install.
import Base
import ./Domain.bend as D

law install_unshown_shown_first:
  {D.showsFirst([D.Install{}]) == True{} : Bool}

def install_unshown_shown_first():
  {==}
