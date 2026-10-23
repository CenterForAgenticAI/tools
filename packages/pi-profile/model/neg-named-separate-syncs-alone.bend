# expect-failure: SOME PROOFS FAIL
# Negative control (L30): a separate profile that is not the default syncs on
# its own anyway. named_separate_never_syncs must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def allSync(k: D.ProfileKind, m: N.AuthMode) -> Bool:
  True{}

law named_separate_never_syncs:
  {allSync(D.NamedProfile{}, N.Separate{}) == False{} : Bool}

def named_separate_never_syncs():
  {==}
