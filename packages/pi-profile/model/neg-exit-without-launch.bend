# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a command that warns and never launches Pi
# exits with Pi's status (7). If it checks, exitCode no longer reads the steps
# and run_passes_pi_exit passes whatever `run` does.
import Base
import ./Domain.bend as D

law exit_without_launch_is_pi_exit:
  {D.exitCode([D.Warn{}], 7n) == 7n : Nat}

def exit_without_launch_is_pi_exit():
  {==}
