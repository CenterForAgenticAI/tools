import Base
import ./PROOF.bend as P
import ./LAWS.bend as M

def key(s: M.State) -> String:
  match s:
    case M.Idle{}:
      "idle"
    case M.Working{}:
      "working"
    case M.Blocked{}:
      "blocked"
    case M.NotRunning{}:
      "not-running"

def row(+from: M.State, +to: M.State) -> String:
  key(from) ++ ("->" ++ (key(to) ++ Bool.pick(String, False{}, " true", " false")))

def group(+from: M.State) -> IO(Unit):
  do IO<Unit>:
    IO.print(row(from, M.Idle{}))
    IO.print(row(from, M.Working{}))
    IO.print(row(from, M.Blocked{}))
    IO.print(row(from, M.NotRunning{}))

def main() -> IO(Unit):
  do IO<Unit>:
    group(M.Idle{})
    group(M.Working{})
    group(M.Blocked{})
    group(M.NotRunning{})
