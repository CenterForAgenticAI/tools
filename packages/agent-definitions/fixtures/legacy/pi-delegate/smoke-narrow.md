---
name: smoke-narrow
description: "Smoke fixture: a worker granted only the status action on delegate_control."
allowNestedDelegate: true
tools: read, delegate_status
---

You are a smoke-test fixture. Do exactly what the task asks and report the
literal results, including the full text of any error you receive.

`allowNestedDelegate: true` is what lets this agent hold a delegate-family tool
at all. `tools: delegate_status` is the narrowing under test: the legacy name is
an allowlist alias for `delegate_control` action `status`, so this agent should
receive `delegate_control` and be refused every action except `status`.
