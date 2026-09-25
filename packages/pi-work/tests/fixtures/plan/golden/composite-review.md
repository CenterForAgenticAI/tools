# Work contract

### spec title

plan-title-sentinel

### spec description

plan-description-sentinel

### spec intent

plan-intent-sentinel

### node address

parent-sentinel

### parent context

_none (root node)_

### id

parent-sentinel

### task

parent-task-sentinel

### description

parent-description-sentinel

### depends_on

[]

### touches

[
  "src/parent-sentinel"
]

### refs

[
  {
    "path": "src/ref-sentinel.ts",
    "lines": "10-20",
    "why": "ref-why-sentinel"
  }
]

### worker

{
  "agent": "agent-sentinel",
  "skills": [
    "skill-sentinel"
  ],
  "model": "model-sentinel"
}

### acceptance (owned by this node)

#### parent-criterion-sentinel

parent-statement-sentinel

Evidence:

{
  "kind": "command",
  "run": "run-sentinel",
  "expect": {
    "exit": 0,
    "output_includes": "output-sentinel"
  }
}

#### parent-agent-criterion-sentinel

parent-agent-statement-sentinel

Evidence:

{
  "kind": "agent",
  "agent": "parent-reviewer-sentinel",
  "inputs": [
    "parent-input-sentinel"
  ],
  "rubric": "parent-rubric-sentinel"
}

#### parent-user-criterion-sentinel

parent-user-statement-sentinel

Evidence:

{
  "kind": "user",
  "prompt": "parent-prompt-sentinel"
}

### checklist

_not declared / not applicable_

### child work roster

- **child-sentinel** — child-task-sentinel _(child acceptance criteria are separately owned)_
- **child-agent-sentinel** — child-agent-task-sentinel _(child acceptance criteria are separately owned)_

### worker-reported evidence

#### parent-criterion-sentinel

worker report line one
worker report line two
