# Transition vocabulary (CONTEXT.md content for an adopting app)

A session is one running unit of work. Its state is idle, working, blocked,
or not-running. A transition asks whether a session may move to a target state.
This example models authorization only, not progress, scheduling or side effects.
