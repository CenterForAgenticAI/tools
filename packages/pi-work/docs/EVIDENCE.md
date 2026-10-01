# Evidence execution reference

For workspec authors and reviewers: how pi-work runs evidence, limits inherited secrets, and contains command processes.

Agent evidence remains unavailable in v1 and fails closed; command and user evidence run today.

Evidence comes in three kinds and none is privileged, because nothing here
assumes the work product is code: `command` (run plus expected exit and
output), `agent` (a rubric judged over named inputs), and `user` (an explicit
human confirmation captured through the session). Command evidence may set
`timeout_ms` to an integer from 1,000 through 3,600,000 milliseconds (one
hour). When absent, `work_verify` allows 30,000 milliseconds; invalid values
are rejected, not clamped. Put `timeout_ms` alongside `run` and `expect` in
the criterion's `evidence` object. For example:

```yaml
evidence:
  kind: command
  run: npm run check
  expect:
    exit: 0
    output_includes: "check passed"
  timeout_ms: 180000
  inherit_env: [PACKAGE_TOKEN]
```

`inherit_env` optionally names up to 32 host environment variables (portable names,
up to 128 characters each). Names must be unique and may not override verifier
controls such as PATH, HOME, XDG, Git, loader, or systemd settings. Missing names
and values shorter than 8 characters fail closed; the failure names the variable,
not its value. An `expect.output_includes` that contains or is
contained in an inherited value also fails closed at run time. Only named
variables reach the evidence command. Exact-value redaction covers values
present in the spec's declared host environment at the time of verification
or status lookup. It removes those values where they appear in rendered output,
details, failure text, and cached observations returned by status. It does not
remember past values across calls: if one command writes an inherited secret
to an ignored file and a later node reads that file after the host variable
changes or disappears, the old value can appear in the later proof, cache, or
status response even when that node has no `inherit_env`. It also does not
contain a command that transforms (for example, encodes or splits) or transmits
a secret. Only inherit secrets into commands you trust. Verification proofs
retain names, never values, for the values in the current snapshot. The default
remains the minimal environment.

A Markdown draft's criteria are preserved verbatim in the promoted skeleton;
`work_promote` does not create evidence objects. Specify the timeout in the
workspec criterion when decomposing that skeleton.

`work_verify` runs command evidence in a Linux systemd user scope
(`KillMode=control-group`) or, on macOS, in a new process group. On macOS it
cleans and checks the group even after a successful command, before reporting
a pass. If a descendant detaches with `setsid` or a double fork but keeps the
command's output pipes open, verification detects that escape and fails. A
descendant that detaches fully, including from those pipes, may survive; the
operator accepted that limit. Other platforms fail closed. Command proofs
record `containment` as `systemd-scope` or `process-group`. Older stored
proofs without the field are interpreted as Linux systemd-scope observations
and do not regain verification authority.
