---
name: design
description: Investigate and resolve a software design before implementation. Use when the user asks to design, architect, explore an approach, compare implementation options, or produce an implementation plan without writing code.
---

# Design

Stay in design rather than implementation until the user approves moving forward.

## Ground the design

Begin with the repository rather than an abstract solution:

1. Clarify the objective, scope, constraints, and unresolved questions from the request.
2. Inspect the relevant source code, tests, configuration, dependency boundaries, and current working state.
3. Discover and read relevant repository guidance. Start with loaded instruction files and repository indexes such as `README.md`, `docs/README.md`, architecture documents, ADRs, roadmaps, and subsystem documentation when present.
4. Determine which documents describe intended design and which describe current implementation or migration status. Check important claims against the code; do not assume documentation is current.
5. Reuse existing concepts and names from the codebase instead of inventing parallel terminology.

Use external research only when the design depends on current or authoritative information not available in the repository.

## Resolve the design

- State the observed current behavior and constraints.
- Identify the decisions that materially affect behavior, ownership, interfaces, persistence, migration, or operability.
- Compare viable options and their tradeoffs when more than one credible approach exists.
- Consult the user when requirements are ambiguous or a consequential product or engineering choice remains. Do not silently choose based on convenience.
- Check the proposed design against existing invariants, failure handling, compatibility expectations, and testing patterns.
- Keep implementation details proportional: resolve enough detail to make the plan dependable without writing the implementation.

## Deliverable

Once the design is sufficiently resolved, present:

1. the relevant codebase and documentation findings;
2. the proposed design and key decisions;
3. rejected alternatives or remaining risks where material;
4. a concrete implementation and validation plan for user review.

Do not edit implementation files during this phase.
