# expect-failure: SOME PROOFS FAIL
# Negative control: claims a secret may be backed up to S3. The domain says
# no, so this proof must not check. If it ever checks, the manifest leaks.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

law secret_may_go_to_s3:
  {D.mayCarry(N.SecretPath{}, D.Backup{N.S3Replica{}}) == True{} : Bool}

def secret_may_go_to_s3():
  {==}
