# expect-failure: SOME PROOFS FAIL
# Negative control (L24): claims a command that warns and then launches Pi
# exits 0, not with Pi's status (7). If it checks, exitCode reads only the
# first step, and run_passes_pi_exit passes for a `run` that drops Pi's exit
# status after a warning.
import Base
import ./Domain.bend as D

law exit_launch_second_is_zero:
  {D.exitCode([D.Warn{}, D.Launch{}], 7n) == 0n : Nat}

def exit_launch_second_is_zero():
  {==}
