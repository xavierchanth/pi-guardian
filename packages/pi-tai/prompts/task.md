---
description: Start a small bounded work order
argument-hint: "[work description]"
---
Start or continue a small-task workflow.

## Work

${ARGUMENTS:-No work description was provided. Begin by asking what I want to work on.}

## Workflow

1. Ground the request with only the repository inspection needed to bound it.
2. If the work is not small, clear, and low in design uncertainty, switch to the full DPIC workflow rather than forcing it into a small work order.
3. Create one `small-product` work order with `work_order_create`. Include implementation instructions, constraints, acceptance criteria, validation requirements, and any documentation or status updates.
4. Launch that work-order ID with `workspace_subagent`; its `small-product` class selects the Worker.
5. Track and acknowledge the result, freeze every nonempty range, obtain independent review, repair blocking findings, integrate only an approved range, reconcile integration conflicts when present, verify acceptance with a documentation disposition, and close workspace custody.

A small task skips the full Design–Plan ceremony; it does not skip durable authority, isolated execution, review, or verification.
