# expect-failure: SOME PROOFS FAIL
# Negative control (L29): a dry run that writes the compressed copy to the
# target before it reports. archive_dry_run_changes_nothing must reject it.
import Base
import ./Domain.bend as D

def dryRunCopies(dryRun: Bool, c: D.CopyCheck) -> List<D.ArchStep>:
  match dryRun:
    case True{}:
      [D.Compress{}, D.Report{}]
    case False{}:
      D.archivePlan(False{}, c)

law archive_dry_run_changes_nothing:
  for +c: D.CopyCheck
  {D.changes(dryRunCopies(True{}, c)) == False{} : Bool}

def archive_dry_run_changes_nothing(c):
  {==}
