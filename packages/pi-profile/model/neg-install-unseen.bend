# expect-failure: SOME PROOFS FAIL
# Negative control (L25): claims a plan that installs does not install. If it
# checks, installs no longer sees an Install and only_flag_installs and the
# never-installs laws pass for a command that installs.
import Base
import ./Domain.bend as D

law install_not_seen:
  {D.installs([D.Install{}]) == False{} : Bool}

def install_not_seen():
  {==}
