# expect-failure: SOME PROOFS FAIL
# Negative control (L21): one machine owns each login. A shared profile pushes
# a login only where /login ran, never a refresh of a login it received from
# a peer. shared_pushes_logins must reject it.
import Base
import ./Enums.bend as N
import ./Domain.bend as D

def ownerOnly(m: N.AuthMode, pushKeys: Bool, s: D.LoginSource, c: D.Cred) -> Bool:
  match s:
    case D.LoggedInHere{}:
      D.autoPush(m, pushKeys, D.LoggedInHere{}, c)
    case D.FromPeer{}:
      False{}

law shared_pushes_logins:
  for +f: Bool
  for +s: D.LoginSource
  for +e: Nat
  {ownerOnly(N.Shared{}, f, s, D.OAuth{e}) == True{} : Bool}

def shared_pushes_logins(f, s, e):
  match s:
    case D.LoggedInHere{}:
      {==}
    case D.FromPeer{}:
      {==}
