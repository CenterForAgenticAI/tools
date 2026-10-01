import Base
import ./LAWS.bend as M

def M.stopped_rejects(to):
  {==}

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
