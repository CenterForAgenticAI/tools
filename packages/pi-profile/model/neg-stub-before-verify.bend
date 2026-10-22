# expect-failure: SOME PROOFS FAIL
# Negative control (L27): an archive that stubs the session as soon as it has
# written the copy, and verifies afterwards. archive_verifies_before_removing
# must reject it.
import Base
import ./Domain.bend as D

def stubEarly(dryRun: Bool, c: D.CopyCheck) -> List<D.ArchStep>:
  match dryRun:
    case True{}:
      [D.Report{}]
    case False{}:
      [D.Report{}, D.Compress{}, D.Stub{}, D.Verified{}, D.Record{}]

law archive_verifies_before_removing:
  for +d: Bool
  for +c: D.CopyCheck
  {D.verifiedFirst(stubEarly(d, c)) == True{} : Bool}

def archive_verifies_before_removing(d, c):
  match d:
    case True{}:
      {==}
    case False{}:
      {==}
