---
name: smoke-plain
description: "Smoke fixture: declares delegate WITHOUT the nested opt-in, so it must be stripped."
tools: read, delegate
---

You are a smoke-test fixture. Do exactly what the task asks.

This agent deliberately asks for `delegate` but does NOT set
`allowNestedDelegate`. The tool must be stripped from its surface: nested
dispatch should be impossible rather than merely refused.
