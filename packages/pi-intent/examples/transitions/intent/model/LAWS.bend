import Base

# Finite decision: stopped sessions reject every transition; otherwise allow.
type State is Data:
  Idle{}
  Working{}
  Blocked{}
  NotRunning{}

def allowed(from: State, to: State) -> Bool:
  match from:
    case NotRunning{}:
      False{}
    case _:
      True{}

law stopped_rejects:
  for to: State
  {allowed(NotRunning{}, to) == False{} : Bool}

def canRun(from: State) -> Bool:
  match from:
    case Idle{}:
      True{}
    case Working{}:
      True{}
    case Blocked{}:
      True{}
    case NotRunning{}:
      False{}

law active_allows:
  for from: State
  for to: State
  {allowed(from, to) == canRun(from) : Bool}
