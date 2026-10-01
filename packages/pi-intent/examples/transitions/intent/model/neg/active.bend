# expect-failure: M.active_allows
import Base
import ../LAWS.bend as M

def M.stopped_rejects(to):
  {==}

def M.active_allows(from, to):
  Unit{}
