# expect-failure: SOME PROOFS FAIL
# Negative control (L27): an archive that stubs the session even when the copy
# on the target did not match. Its steps are in order, so verifiedFirst alone
# accepts it; archive_keeps_unverified must reject it.
import Base
import ./Domain.bend as D

def stubAnyway(dryRun: Bool, c: D.CopyCheck) -> List<D.ArchStep>:
  match dryRun:
    case True{}:
      [D.Report{}]
    case False{}:
      [D.Report{}, D.Compress{}, D.Verified{}, D.Record{}, D.Stub{}]

law archive_keeps_unverified:
  for +d: Bool
  for +c: D.CopyCheck
  {Bool.and(D.removes(stubAnyway(d, c)), Bool.not(D.copyMatches(c))) == False{} : Bool}

def archive_keeps_unverified(d, c):
  match d:
    case True{}:
      {==}
    case False{}:
      match c:
        case D.CopyMatches{}:
          {==}
        case D.CopyDiffers{}:
          {==}
        case D.CopyMissing{}:
          {==}
