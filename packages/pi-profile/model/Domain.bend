# Domain model of pi-profile.
#
# Descriptive model of the design in ../.spec/design.md (draft v1, 2026-10-01).
# There is no implementation yet; these defs state the decisions the code must
# follow. LAWS.bend states the rules; PROOF.bend proves them.
#
# Hosts, profiles, paths and secrets are numbers here: the laws are about how
# they relate, not about their spelling.

import Base
import ./Lib.bend as L
import ./Enums.bend as N

# An optional value (a flag, an environment variable, a setting).
type Opt is Data:
  NoVal{}
  Val{v: Nat}

# ---------------------------------------------------------------- profile selection

# Where the launcher found the profile to run. Mirrors the fish utility:
# an explicit `run NAME`/`--profile` wins, then an exported
# PI_CODING_AGENT_DIR, then the global default unless
# PI_PROFILE_NO_GLOBAL_DEFAULT is set, then the built-in `default` (~/.pi/agent).
type Source is Data:
  Explicit{}
  Exported{}
  GlobalDefault{}
  BuiltinDefault{}

def globalOr(g: Opt) -> Source:
  match g:
    case NoVal{}:
      BuiltinDefault{}
    case Val{v}:
      GlobalDefault{}

def afterExported(noGlobal: Bool, g: Opt) -> Source:
  match noGlobal:
    case True{}:
      BuiltinDefault{}
    case False{}:
      globalOr(g)

def afterExplicit(x: Opt, noGlobal: Bool, g: Opt) -> Source:
  match x:
    case NoVal{}:
      afterExported(noGlobal, g)
    case Val{v}:
      Exported{}

def selectSource(e: Opt, x: Opt, g: Opt, noGlobal: Bool) -> Source:
  match e:
    case NoVal{}:
      afterExplicit(x, noGlobal, g)
    case Val{v}:
      Explicit{}

def isGlobal(s: Source) -> Bool:
  match s:
    case Explicit{}:
      False{}
    case Exported{}:
      False{}
    case GlobalDefault{}:
      True{}
    case BuiltinDefault{}:
      False{}

# ---------------------------------------------------------------- session storage

# Pi's session directory: --session-dir, then PI_CODING_AGENT_SESSION_DIR,
# then the `sessionDir` setting, then <agent-dir>/sessions.
def orElse(o: Opt, d: Nat) -> Nat:
  match o:
    case NoVal{}:
      d
    case Val{v}:
      v

def sessionDir(flag: Opt, env: Opt, setting: Opt, profileDefault: Nat) -> Nat:
  match flag:
    case NoVal{}:
      match env:
        case NoVal{}:
          orElse(setting, profileDefault)
        case Val{v}:
          v
    case Val{v}:
      v

# ---------------------------------------------------------------- repositories

# The subtree hosts/<owner>/ inside a session repository.
type Subtree is Data:
  Subtree{owner: Nat}

def subtreeOwner(s: Subtree) -> Nat:
  match s:
    case Subtree{o}:
      o

# The only subtree a host's backup writes to.
def backupTarget(self: Nat) -> Subtree:
  Subtree{self}

# A host may write a subtree only when it owns it.
def writable(self: Nat, s: Subtree) -> Bool:
  Nat.is_eq(self, subtreeOwner(s))

# A session file: the host that writes it, and the host it came from.
type Sess is Data:
  Sess{owner: Nat, origin: Nat}

def sessOwner(s: Sess) -> Nat:
  match s:
    case Sess{o, g}:
      o

# Continuing another host's session forks it; the fork belongs to the local host.
def fork(self: Nat, s: Sess) -> Sess:
  match s:
    case Sess{o, g}:
      Sess{self, o}

# ---------------------------------------------------------------- replicas and encryption

# A replica's `encrypt` setting: inherit the kind's default, or force it.
type Override is Data:
  Inherit{}
  Force{on: Bool}

def encryptDefault(k: N.ReplicaKind) -> Bool:
  match k:
    case N.LocalReplica{}:
      False{}
    case N.SshReplica{}:
      False{}
    case N.S3Replica{}:
      True{}

def encrypts(k: N.ReplicaKind, o: Override) -> Bool:
  match o:
    case Inherit{}:
      encryptDefault(k)
    case Force{b}:
      b

# ---------------------------------------------------------------- what may move where

# Ways data leaves a profile directory.
type Channel is Data:
  ConfigSync{}
  Backup{kind: N.ReplicaKind}
  AuthTransfer{}

# Who holds the bytes at the far end.
type Reach is Data:
  Tailnet{}
  ThirdParty{}

def isThirdParty(r: Reach) -> Bool:
  match r:
    case Tailnet{}:
      False{}
    case ThirdParty{}:
      True{}

def kindReach(k: N.ReplicaKind) -> Reach:
  match k:
    case N.LocalReplica{}:
      Tailnet{}
    case N.SshReplica{}:
      Tailnet{}
    case N.S3Replica{}:
      ThirdParty{}

# Config sync is git over Tailscale SSH; auth transfer is `ssh <peer>`.
def reach(ch: Channel) -> Reach:
  match ch:
    case ConfigSync{}:
      Tailnet{}
    case Backup{k}:
      kindReach(k)
    case AuthTransfer{}:
      Tailnet{}

def isSecret(c: N.PathClass) -> Bool:
  match c:
    case N.ConfigPath{}:
      False{}
    case N.StatePath{}:
      False{}
    case N.SecretPath{}:
      True{}
    case N.SessionsPath{}:
      False{}
    case N.UnknownPath{}:
      False{}

# The sync manifest: deny by default. Config rides config sync, sessions ride
# backups, secrets ride only an explicit auth transfer, and machine-local
# state and unclassified paths never leave the host.
def mayCarry(c: N.PathClass, ch: Channel) -> Bool:
  match c:
    case N.ConfigPath{}:
      match ch:
        case ConfigSync{}:
          True{}
        case Backup{k}:
          False{}
        case AuthTransfer{}:
          False{}
    case N.StatePath{}:
      False{}
    case N.SecretPath{}:
      match ch:
        case ConfigSync{}:
          False{}
        case Backup{k}:
          False{}
        case AuthTransfer{}:
          True{}
    case N.SessionsPath{}:
      match ch:
        case ConfigSync{}:
          False{}
        case Backup{k}:
          True{}
        case AuthTransfer{}:
          False{}
    case N.UnknownPath{}:
      False{}

# ---------------------------------------------------------------- auth

# Where a profile's auth.json points.
type AuthFile is Data:
  SharedAuth{}
  ProfileAuth{profile: Nat}

def authProfile(f: AuthFile) -> Nat:
  match f:
    case SharedAuth{}:
      0n
    case ProfileAuth{p}:
      p

def authFile(m: N.AuthMode, p: Nat) -> AuthFile:
  match m:
    case N.Shared{}:
      SharedAuth{}
    case N.Separate{}:
      ProfileAuth{p}
    case N.Pooled{}:
      ProfileAuth{p}

# One provider entry in auth.json. Keys and tokens are numbers; an OAuth
# entry is reduced to its expiry time.
type Cred is Data:
  ApiKey{key: Nat}
  OAuth{expires: Nat}

# Merge an incoming entry into the local one (`pi-profile auth receive`).
# --force takes the incoming entry. Otherwise an API key is never replaced,
# and an OAuth entry is replaced only by one that expires later.
def mergeLocal(l: Cred, i: Cred) -> Cred:
  match l i:
    case ApiKey{a} ApiKey{b}:
      ApiKey{a}
    case ApiKey{a} OAuth{ie}:
      ApiKey{a}
    case OAuth{le} ApiKey{b}:
      OAuth{le}
    case OAuth{+le} OAuth{+ie}:
      Bool.pick(Cred, L.ltN(le, ie), OAuth{ie}, OAuth{le})

def merge(l: Cred, i: Cred, force: Bool) -> Cred:
  match force:
    case True{}:
      i
    case False{}:
      mergeLocal(l, i)

# When an entry stops working. An API key does not expire; it reads as 0, and
# the laws read an expiry only where the local entry is an OAuth login.
def credExpiry(c: Cred) -> Nat:
  match c:
    case ApiKey{k}:
      0n
    case OAuth{e}:
      e

# How this machine came to hold a login: it ran /login here, or it received
# the login from a peer.
type LoginSource is Data:
  LoggedInHere{}
  FromPeer{}

# Whether a profile pushes an entry to its peers on its own when it changes.
# Shared and pooled profiles push OAuth logins. Any machine may refresh a
# shared login and push it: no machine owns a login, so the push does not
# depend on the LoginSource. An API key is pushed only when the profile turns
# on its own flag for that (pushKeys). A separate profile pushes nothing.
def pushesCred(pushKeys: Bool, c: Cred) -> Bool:
  match c:
    case ApiKey{k}:
      pushKeys
    case OAuth{e}:
      True{}

def autoPush(m: N.AuthMode, pushKeys: Bool, s: LoginSource, c: Cred) -> Bool:
  match m:
    case N.Shared{}:
      pushesCred(pushKeys, c)
    case N.Separate{}:
      False{}
    case N.Pooled{}:
      pushesCred(pushKeys, c)

# Which profile a process runs in. The default profile is Pi's own
# ~/.pi/agent and owns the shared auth.json; every other profile is named.
type ProfileKind is Data:
  DefaultProfile{}
  NamedProfile{}

# Whether a profile pushes and pulls logins on its own. The default profile
# always does: its auth.json is the shared one, so it syncs like a shared
# profile, although its stored mode stays separate. A named profile follows
# its mode: shared and pooled sync, separate does not.
def syncsOnItsOwn(k: ProfileKind, m: N.AuthMode) -> Bool:
  match k:
    case DefaultProfile{}:
      True{}
    case NamedProfile{}:
      match m:
        case N.Shared{}:
          True{}
        case N.Separate{}:
          False{}
        case N.Pooled{}:
          True{}

# Whether a profile of kind k and stored mode m pushes an entry on its own
# when it changes: only a profile that syncs on its own, and then by the same
# rule for each entry as autoPush (OAuth logins always, API keys behind
# pushKeys).
def profilePush(k: ProfileKind, m: N.AuthMode, pushKeys: Bool, s: LoginSource, c: Cred) -> Bool:
  Bool.and(syncsOnItsOwn(k, m), pushesCred(pushKeys, c))

# ---------------------------------------------------------------- pi-multi-account

# The profile's pi-multi-account config: the group table, the default group,
# and every other key, which pi-profile must leave alone.
type MaCfg is Data:
  MaCfg{groups: Nat, dflt: Opt, other: Nat}

type Applied is Data:
  Refused{}
  Written{cfg: MaCfg}

def setDefault(c: MaCfg, g: Nat) -> MaCfg:
  match c:
    case MaCfg{gs, d, o}:
      MaCfg{gs, Val{g}, o}

def maOther(c: MaCfg) -> Nat:
  match c:
    case MaCfg{gs, d, o}:
      o

def maGroups(c: MaCfg) -> Nat:
  match c:
    case MaCfg{gs, d, o}:
      gs

# Set defaultAccountGroup. Fails closed when the group is not defined.
def applyGroup(known: Bool, c: MaCfg, g: Nat) -> Applied:
  match known:
    case False{}:
      Refused{}
    case True{}:
      Written{setDefault(c, g)}

# ---------------------------------------------------------------- the Pi version pin and installs

# How the Pi on PATH compares with the Pi version pin of a profile's hub
# (issue 34). PinUnknown: the pin or Pi's version could not be read.
type PinCheck is Data:
  NoPin{}
  PinMatches{}
  PinMismatch{}
  PinUnknown{}

# The commands that read the pin or can install software. A command that can
# install carries its explicit install flag: `pin --install` and
# `sync pull --install-packages`. The others have no install flag.
type Command is Data:
  Run{}
  Doctor{}
  Enrol{}
  Pin{install: Bool}
  SyncPull{installPackages: Bool}

# What a command does, in order. Show prints the exact command line of the
# install that follows it. Refuse ends the command (exit 2). Launch hands over
# to Pi; the command exits with Pi's status (see exitCode).
type Step is Data:
  Warn{}
  Refuse{}
  Launch{}
  Show{}
  Install{}

def installFlag(c: Command) -> Bool:
  match c:
    case Run{}:
      False{}
    case Doctor{}:
      False{}
    case Enrol{}:
      False{}
    case Pin{i}:
      i
    case SyncPull{i}:
      i

# `run`: a pin that does not match, or cannot be checked, is a warning; Pi is
# launched either way.
def runPlan(p: PinCheck) -> List<Step>:
  match p:
    case NoPin{}:
      [Launch{}]
    case PinMatches{}:
      [Launch{}]
    case PinMismatch{}:
      [Warn{}, Launch{}]
    case PinUnknown{}:
      [Warn{}, Launch{}]

# `doctor` and the pin step of `enrol`: report the pin, change nothing.
def checkPlan(p: PinCheck) -> List<Step>:
  match p:
    case NoPin{}:
      []
    case PinMatches{}:
      []
    case PinMismatch{}:
      [Warn{}]
    case PinUnknown{}:
      [Warn{}]

# `pin`: only --install installs, and only when Pi does not already match. It
# refuses when there is no pin. At run time it also refuses when it cannot
# tell how Pi was installed; the model keeps the branch that installs.
def pinPlan(install: Bool, p: PinCheck) -> List<Step>:
  match install:
    case False{}:
      []
    case True{}:
      match p:
        case NoPin{}:
          [Refuse{}]
        case PinMatches{}:
          []
        case PinMismatch{}:
          [Show{}, Install{}]
        case PinUnknown{}:
          [Show{}, Install{}]

# `sync pull`: --install-packages installs the missing npm: and git: packages.
def pullPlan(install: Bool) -> List<Step>:
  match install:
    case False{}:
      []
    case True{}:
      [Show{}, Install{}]

def plan(c: Command, p: PinCheck) -> List<Step>:
  match c:
    case Run{}:
      runPlan(p)
    case Doctor{}:
      checkPlan(p)
    case Enrol{}:
      checkPlan(p)
    case Pin{i}:
      pinPlan(i, p)
    case SyncPull{i}:
      pullPlan(i)

def isWarn(s: Step) -> Bool:
  match s:
    case Warn{}:
      True{}
    case Refuse{}:
      False{}
    case Launch{}:
      False{}
    case Show{}:
      False{}
    case Install{}:
      False{}

def isRefuse(s: Step) -> Bool:
  match s:
    case Warn{}:
      False{}
    case Refuse{}:
      True{}
    case Launch{}:
      False{}
    case Show{}:
      False{}
    case Install{}:
      False{}

def isLaunch(s: Step) -> Bool:
  match s:
    case Warn{}:
      False{}
    case Refuse{}:
      False{}
    case Launch{}:
      True{}
    case Show{}:
      False{}
    case Install{}:
      False{}

def isShow(s: Step) -> Bool:
  match s:
    case Warn{}:
      False{}
    case Refuse{}:
      False{}
    case Launch{}:
      False{}
    case Show{}:
      True{}
    case Install{}:
      False{}

def isInstall(s: Step) -> Bool:
  match s:
    case Warn{}:
      False{}
    case Refuse{}:
      False{}
    case Launch{}:
      False{}
    case Show{}:
      False{}
    case Install{}:
      True{}

def hasStep(~f: Step -> Bool, xs: List<Step>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case h <> t:
      Bool.or(f(h), hasStep(~f, t))

def warns(xs: List<Step>) -> Bool:
  hasStep(~isWarn, xs)

def refuses(xs: List<Step>) -> Bool:
  hasStep(~isRefuse, xs)

def launches(xs: List<Step>) -> Bool:
  hasStep(~isLaunch, xs)

def installs(xs: List<Step>) -> Bool:
  hasStep(~isInstall, xs)

# Every Install comes straight after a Show.
def showsFirst.go(xs: List<Step>, shown: Bool) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case +h <> t:
      Bool.and(Bool.or(shown, Bool.not(isInstall(h))), showsFirst.go(t, isShow(h)))

def showsFirst(xs: List<Step>) -> Bool:
  showsFirst.go(xs, False{})

# The exit status of a command that takes steps xs, when the Pi it launches
# exits with piExit. Refuse ends the command with exit 2. Launch ends it too:
# the command exits with Pi's status. A command that does neither exits 0.
# The model leaves out the exits that happen before the pin check: other
# failures (exit 1), refusals not caused by the pin, such as a profile that
# does not exist (exit 2), and a `pi` that cannot start (exit 127).
def exitStep(s: Step, piExit: Nat, rest: Nat) -> Nat:
  match s:
    case Warn{}:
      rest
    case Refuse{}:
      2n
    case Launch{}:
      piExit
    case Show{}:
      rest
    case Install{}:
      rest

def exitCode(xs: List<Step>, +piExit: Nat) -> Nat:
  match xs:
    case Nil{}:
      0n
    case h <> t:
      exitStep(h, piExit, exitCode(t, piExit))

# ---------------------------------------------------------------- the session archive

# What reading the archived copy back from the target found: it matches the
# session (decompressed bytes and SHA-256), it differs, or it is not there.
type CopyCheck is Data:
  CopyMatches{}
  CopyDiffers{}
  CopyMissing{}

# What an archive run does to one session, in order. Report lists the session
# and the bytes it would free. Compress writes the compressed copy to the
# target. Verified means the copy on the target was read back and matched.
# Record writes the manifest entry. Stub replaces the live file with a small
# stub (header, name, first prompt). Delete removes the live file; the archive
# as decided leaves a stub, and Delete is here so the laws also cover an
# archive that removes the file outright.
type ArchStep is Data:
  Report{}
  Compress{}
  Verified{}
  Record{}
  Stub{}
  Delete{}

# A dry run only reports. With --apply the session is stubbed only after its
# copy verified; a copy that did not verify leaves the session in place.
def archivePlan(dryRun: Bool, c: CopyCheck) -> List<ArchStep>:
  match dryRun:
    case True{}:
      [Report{}]
    case False{}:
      match c:
        case CopyMatches{}:
          [Report{}, Compress{}, Verified{}, Record{}, Stub{}]
        case CopyDiffers{}:
          [Report{}, Compress{}]
        case CopyMissing{}:
          [Report{}, Compress{}]

def copyMatches(c: CopyCheck) -> Bool:
  match c:
    case CopyMatches{}:
      True{}
    case CopyDiffers{}:
      False{}
    case CopyMissing{}:
      False{}

# Steps that change something: everything but Report.
def isChange(s: ArchStep) -> Bool:
  match s:
    case Report{}:
      False{}
    case Compress{}:
      True{}
    case Verified{}:
      True{}
    case Record{}:
      True{}
    case Stub{}:
      True{}
    case Delete{}:
      True{}

# Steps that take the full session out of the live store.
def isRemoval(s: ArchStep) -> Bool:
  match s:
    case Report{}:
      False{}
    case Compress{}:
      False{}
    case Verified{}:
      False{}
    case Record{}:
      False{}
    case Stub{}:
      True{}
    case Delete{}:
      True{}

def isVerified(s: ArchStep) -> Bool:
  match s:
    case Report{}:
      False{}
    case Compress{}:
      False{}
    case Verified{}:
      True{}
    case Record{}:
      False{}
    case Stub{}:
      False{}
    case Delete{}:
      False{}

def hasArch(~f: ArchStep -> Bool, xs: List<ArchStep>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case h <> t:
      Bool.or(f(h), hasArch(~f, t))

def changes(xs: List<ArchStep>) -> Bool:
  hasArch(~isChange, xs)

def removes(xs: List<ArchStep>) -> Bool:
  hasArch(~isRemoval, xs)

# Every Stub or Delete comes after a Verified.
def verifiedFirst.go(xs: List<ArchStep>, +seen: Bool) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case +h <> t:
      Bool.and(Bool.or(seen, Bool.not(isRemoval(h))), verifiedFirst.go(t, Bool.or(seen, isVerified(h))))

def verifiedFirst(xs: List<ArchStep>) -> Bool:
  verifiedFirst.go(xs, False{})

# Restoring an archived session over its stub. `added` is the number of lines
# written to the stub after it was archived (the session was continued from
# the stub). An untouched stub is replaced by the restored file; a stub with
# added lines is kept, and the restored file is written beside it.
type Restore is Data:
  ReplaceStub{}
  KeepBoth{}

def restoreAct(added: Nat) -> Restore:
  match added:
    case 0n:
      ReplaceStub{}
    case 1n+n:
      KeepBoth{}

def overwritesStub(r: Restore) -> Bool:
  match r:
    case ReplaceStub{}:
      True{}
    case KeepBoth{}:
      False{}

# Whether a merge without --force takes the incoming OAuth login. lw and iw
# are the times the local and incoming copies were written; le and ie are
# their expiry times. The later write wins whatever the expiry says; equal
# write times fall back to the later expiry; a full tie keeps the local copy.
def takeIncoming(+lw: Nat, le: Nat, +iw: Nat, ie: Nat) -> Bool:
  Bool.pick(Bool, L.ltN(lw, iw), True{}, Bool.pick(Bool, L.ltN(iw, lw), False{}, L.ltN(le, ie)))
