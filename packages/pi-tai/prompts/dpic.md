---
description: Start a Design–Plan–Implement–Closure workflow
argument-hint: "[work description]"
---
Start or continue a complete Design–Plan–Implement–Closure workflow.

## Work

${ARGUMENTS:-No work description was provided. Begin by asking what I want to work on.}

## Workflow

1. **Design**
   - Ground the request in the repository, tests, configuration, and authoritative documentation.
   - Identify decisions that could materially affect behavior, scope, architecture, interfaces, persistence, compatibility, migration, failure handling, or acceptance criteria.
   - Ask focused questions for unresolved consequential decisions; do not manufacture questions when the request and repository already provide clarity.
   - Move to Plan only when the intended outcome, repository behavior, boundaries, constraints, key decisions, and acceptance criteria are clear enough that implementation will not need to invent product or architectural intent.
   - Exact file ownership, mechanical sequencing, and minor internal choices governed by repository conventions do not block planning.

2. **Plan**
   - Summarize the resolved design and create one `large-product` work order with `work_order_create`, including complete implementation, validation, documentation, and closure requirements.
   - If planning exposes a material unresolved decision, return to Design instead of guessing.
   - Otherwise proceed without requesting ceremonial approval.

3. **Implement**
   - Launch the work-order ID with `workspace_subagent`; `large-product` selects an Implementation Lead and `documentation` selects a Documenter.
   - Track delegated work through validation and a frozen exact range.

4. **Closure**
   - Collect and acknowledge every delegated result, then normalize and freeze each nonempty range.
   - Send every nonempty range to an independent Reviewer; return blocking findings to the original implementation role and re-review.
   - Integrate only the approved range, reconcile integration conflicts with Bash/JJ plus focused review when needed, and verify the resulting code and product acceptance.
   - Update relevant documentation and status records, clean up temporary state, close workspace custody, and report the completed outcome and any follow-up.

Use deterministic tool constraints, workspace ownership, review evidence, and Guardian policy as the safety boundaries. Ask the user for consequential design decisions or genuinely ambiguous recovery choices, not method-level approval.
