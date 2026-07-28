---
name: documentation-system
description: Design, create, migrate, or audit a future-first repository documentation system with explicit architecture, specification, protocol, reference, guides, roadmap, and repository-engineering authorities. Use for greenfield documentation setup or brownfield documentation reorganization in either a single-project repository or a repository containing multiple major projects.
---

# Documentation system

Create a documentation system organized by reader need and semantic authority, not by the incidental source tree. Support two selectable layouts:

- **Single-project:** one main product or system, as in Pi-Tai.
- **Multi-project:** several independently understandable products or systems sharing one repository, as in Mono.

Do not choose a layout until completing discovery and asking the initial questions.

## Start with discovery

1. Read repository instructions, the root `README.md`, existing documentation indexes, roadmaps, architecture records, build configuration, and relevant source/test entry points.
2. Inventory first-party Markdown. Exclude dependencies, generated output, VCS workspaces, build output, and temporary archives unless the user explicitly wants historical evidence assessed.
3. Check important documentation claims against source, tests, and configuration. Distinguish intended design from released behavior and migration status.
4. Reuse existing product and domain names. Do not invent parallel terminology merely to fit this layout.
5. Determine whether the task is greenfield or brownfield. Treat a repo with scattered or conflicting documentation as brownfield even if it lacks a `docs/` directory.

Read [the system model](references/system-model.md) before designing the tree. For brownfield work, also read [the migration workflow](references/brownfield.md).

## Ask the initial questions

Summarize what discovery already answered, then ask only unresolved questions. Prefer one compact numbered questionnaire with recommended defaults:

1. **Project shape:** Is there one main product/system, or multiple projects with distinct audiences, contracts, or roadmaps?
2. **Shared documentation:** If there are multiple projects, which concerns are truly repo-wide rather than owned by one project?
3. **Repository engineering:** Is a separate `repo/` area needed for layout, tooling, CI, infrastructure, workspace, and release conventions, or can those remain in the root README and contributor guidance?
4. **Required roles:** Which of architecture, specification, protocols, reference, developer guides, operations, and roadmap are materially needed?
5. **Authority model:** Are docs future-first, release-first, or mixed? Recommend future-first canonical design plus a roadmap delta unless the repository has a strong release-versioned documentation requirement.
6. **Audiences:** Who needs a reading path—maintainers, application developers, operators, protocol implementers, end users?
7. **Migration policy:** Which historical documents must be retained as evidence, and may obsolete/conflicting documents be retired after their enduring decisions are incorporated?
8. **Validation/tooling:** Which runtime and task runner should own documentation checks?

Do not ask the user for facts that repository inspection can establish. If the user wants a recommendation, explain the consequential choice and propose one.

## Select the layout

Use [selectable layouts](references/layouts.md).

Choose **single-project** when one product statement, authority model, terminology set, and roadmap can coherently govern the repository. The presence of many packages does not by itself make a repo multi-project.

Choose **multi-project** when major projects need separate entry points or can evolve with distinct architecture, specifications, audiences, or roadmaps. Keep a shallow repository-wide index and place canonical material under each project. Do not create a fake shared layer by extracting coincidentally similar concepts.

The `repo/` area is independently selectable in either layout. Add it only when repository engineering guidance is substantial enough to deserve an authority separate from product/system docs.

Present the proposed tree, authority precedence, canonical concept owners, migration dispositions, and omitted roles for approval before a broad brownfield rewrite.

## Build the system

1. Create the minimum set of roles needed; avoid empty ceremonial directories.
2. Give every documentation area an indexed `README.md` with annotated links.
3. Give every page exactly one H1 and an opening paragraph stating purpose and scope. Include audience, authority, or release status when ambiguity is likely.
4. Define precedence where architecture, specifications, protocols, and released implementation can overlap.
5. Keep intended design outside the roadmap. Put implementation gaps, sequencing, temporary compatibility, and delivery state only in the roadmap.
6. Keep exact released behavior authoritative in source and tests unless the repository deliberately publishes versioned release specifications.
7. Define every state machine, schema, ownership rule, status, and stable term once. Other pages link to that authority.
8. Use relative Markdown links. Parent indexes link to child indexes rather than duplicating every descendant.
9. Add concise documentation conventions to repository agent/contributor guidance.
10. Add automated validation appropriate to the repository. `assets/check-docs.mjs` is a dependency-free Node starting point.

Use [document roles and style](references/document-roles.md) while writing.

## Roadmaps

A roadmap is the sole delivery-state authority, not a progress diary.

- Use stable capability identifiers when readers need durable references.
- Keep capability delivery state distinct from initiative planning stage when both are needed.
- Initiatives describe bounded outcomes, constraints, dependencies, decisions, approval gates, and acceptance criteria.
- Version-control history records completed checkpoints.
- When work changes behavior, update source, tests, canonical docs, and roadmap state together.
- Remove or reduce initiatives once accepted decisions and delivered state have been absorbed by their canonical authorities.

## Brownfield safeguards

- Do not move or delete documents until their active decisions and incoming links are accounted for.
- Do not assume current prose is true because it is under `docs/`.
- Do not convert repository paths into architectural boundaries without checking domain ownership.
- Do not claim target-only APIs are executable in developer guides.
- Do not preserve conflicting documents as a second normative tree. Retain immutable historical evidence only when it has a clear label and purpose.
- Separate broad documentation moves from security-sensitive or behavior-changing code work.

## Validate

At minimum verify:

- exactly one H1 per page and no skipped heading levels;
- local files and heading fragments resolve;
- every canonical docs page is reachable from an index;
- new, moved, and removed pages have correct incoming links;
- each important concept and delivery status has one authority;
- roadmap prose contains no duplicate canonical design;
- architecture/specification prose contains no transient status or progress diary;
- repository-provided formatting and documentation checks pass.

Report the selected layout, created or migrated authorities, retired or deferred material, validation results, and any remaining ambiguous ownership.