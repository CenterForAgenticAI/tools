# Previous overview and license reference

For maintainers: the opening and license text from the pre-standard README, retained verbatim except for relative links adjusted after the move.

## Previous overview

`pi-multi-account` keeps Pi working when an Anthropic or OpenAI Codex OAuth
account reaches a limit or loses authorization. It registers numbered account
aliases, observes provider health, and moves a settled turn to an eligible
account. **Failover** means moving that turn after the active account fails.

The extension is OAuth-first. Credentials remain in Pi's `AuthStorage`.
Discovery uses Pi's public credential adapter first and a narrow read-only
`auth.json` fallback when that adapter is unavailable. Both paths project only
presence, expiry, a derived fingerprint, and an optional Codex label. Raw values
do not leave that boundary. The package never writes `auth.json` or puts tokens
in its own state or diagnostics. OpenRouter is available only as an explicitly
enabled, budgeted final rung in a non-delegate Pi session. It is off by default
and blocked inside delegate sessions.

## License

Our code is available under the [MIT License](../../LICENSE). This package also
contains modified MIT-licensed copies of `pi-anthropic-oauth` and
`pi-antigravity`; see [NOTICE](../../NOTICE) and each fork's included `LICENSE` file.
