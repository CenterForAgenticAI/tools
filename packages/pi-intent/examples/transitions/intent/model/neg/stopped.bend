# expect-failure: M.stopped_rejects
import Base
import ../LAWS.bend as M

def M.stopped_rejects(to):
  Unit{}

def M.active_allows(from, to):
  match from:
    case M.Idle{}:
      {==}
    case M.Working{}:
      {==}
    case M.Blocked{}:
      {==}
    case M.NotRunning{}:
      {==}
