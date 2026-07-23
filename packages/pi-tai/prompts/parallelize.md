---
description: Delegate the approved implementation plan to parallel isolated agents
argument-hint: "[additional constraints]"
---

Implement the approved plan through isolated JJ workspace children rather than inline. Decompose it into as many independent slices as useful. For each slice, call `workspace_subagent`, choosing `planner` when decomposition is needed and `worker` for bounded implementation. Include these additional constraints when relevant:

```
${ARGUMENTS:-None.}
```

Avoid overlapping assignments. Repeatedly call `wait_for_children`, handle questions, and collect every terminal result. Integrate each completed workspace with `integrate_workspace`. Inspect every retained revision reported as undescribed and call `describe_integrated_changes` with meaningful Conventional Commit descriptions. Continue waiting until no owned child is unresolved or uncollected before presenting completion.
