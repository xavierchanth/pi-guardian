---
description: Start a Design–Plan–Implement–Confirm workflow
argument-hint: "[work description]"
---
Start or continue a complete Design–Plan–Implement–Confirm workflow.

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
   - Summarize the resolved design and persist a complete implementation and validation plan.
   - If planning exposes a material unresolved decision, return to Design instead of guessing.
   - Otherwise proceed without requesting ceremonial approval.

3. **Implement**
   - Create a durable plan-bound assignment and delegate it to the appropriate managed workspace role.
   - Track delegated work through validation and a frozen exact range.

4. **Confirm**
   - Send every nonempty range to an independent Reviewer.
   - If review blocks, return the work to its original implementation role and re-review.
   - When review is clean, integrate the exact reviewed range, verify acceptance, and close workspace custody.

Use deterministic tool constraints, workspace ownership, review evidence, and Guardian policy as the safety boundaries. Ask the user for consequential design decisions or genuinely ambiguous recovery choices, not method-level approval.
