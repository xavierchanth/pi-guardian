# Subagent lifecycle specifications

This suite records expected subagent lifecycle behavior. In this slice every case is intentionally `specification-only`: the runner validates YAML and reports each case as **skipped**. It does not launch Pi, simulate RPC, or claim protocol results.

## Validate and report

```bash
node --experimental-strip-types evals/subagents/run.ts
```

The command exits successfully after schema validation and writes ignored JSON and Markdown under `reports/<timestamp>/`. A malformed case fails the command before a report is claimed.

## Versioned case schema

All eval suites use the strict loader in `evals/shared/cases.ts`. Common fields are `version`, `suite`, unique kebab-case `id`, non-empty `title`, `execution`, and discriminated `setup`, `interaction`, and `assertions`. Unknown fields, unknown kinds, wrong scalar types, duplicate IDs, and suite mismatches are rejected with source paths.

```yaml
version: 1
suite: subagents
id: wait-any-repeated-collection
title: "Wait-any is repeated until every child is collected"
execution: specification-only
setup:
  kind: subagent-harness
  parentRole: implementation-lead
  childRole: worker
  childOutcome: completed
interaction:
  kind: wait-any-collection
  childCount: 3
assertions:
  - kind: protocol-invariant
    invariant: collect-every-child
```

Interaction kinds encode one bounded Given–When scenario; assertion kinds encode expected Then observations. Interim implementation-lead and worker cases explicitly require the observable sequence `parent-steer`, visible bounded status, subsequent work/tool activity, and one later terminal report, with zero interim reports.

## Add a case

1. Copy the closest YAML file in `cases/` and choose a unique kebab-case `id`.
2. Keep `version: 1`, `suite: subagents`, and `execution: specification-only` until a real protocol driver and oracle exist.
3. Use only the exact fields for the selected discriminated kinds; add schema variants in `evals/shared/cases.ts` when a genuinely new behavior is needed.
4. Run the validation command and confirm the case appears as skipped, never passed.
