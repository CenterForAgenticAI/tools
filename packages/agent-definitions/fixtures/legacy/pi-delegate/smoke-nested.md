---
name: smoke-nested
description: "Smoke fixture: a worker allowed to dispatch its own sub-workers."
allowNestedDelegate: true
tools: read, delegate
---

You are a smoke-test fixture for nested delegation. Do exactly what the task
asks and report literal results, including the full text of any error.

`allowNestedDelegate: true` is what lets this agent hold the `delegate` tool at
all. Without it the tool is stripped from the worker's surface, and a nested
dispatch is impossible rather than merely refused.
