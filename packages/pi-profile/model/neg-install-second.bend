# expect-failure: SOME PROOFS FAIL
# Negative control (L25): claims a plan whose Install comes second does not
# install. If it checks, installs reads only the first step, and a `run` plan
# such as [Show, Install, Launch] installs with every law still checking.
import Base
import ./Domain.bend as D

law install_second_not_seen:
  {D.installs([D.Launch{}, D.Install{}]) == False{} : Bool}

def install_second_not_seen():
  {==}
