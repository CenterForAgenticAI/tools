# Synthetic fold corpus

`cases.json` is hand-written. It contains no real session text. The runner seeds
16 large alternating user/assistant messages plus eight recent user messages.
Each seed repeats an invented archive sentence to clear the default 5,000-token
minimum without needing a provider or copied transcript. References are literals,
not discovered from either engine's output.

The edge-pair case instead starts with a user, assistant `archive_probe` call,
its result, user, second assistant call, and its result. Its requested endpoints
are the first result and the second call, so boundary draining must preserve
pairing. The remaining old and recent messages use the same synthetic seed.

Each case uses a new temporary session. Tier two first creates two disjoint
folds, then folds `b1..b2` on the next turn. `fabric-nested` calls `compress`
through `ctx.executeTool` from a parent whose id starts with `fabric_`.
`expectedBcpTiers` verifies the scenario actually happened, not parity. The
runner fails if a scenario is not exercised, evidence is absent/inconclusive,
or the existing register cannot explain a difference. It prints all failures,
not just the command's bounded display sample. Do not add real transcripts here.
