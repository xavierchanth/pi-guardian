# Workspace skill behavioral evaluations

A seeded behavioral suite using real ephemeral JJ/Git repositories. Normal project tests do not run this suite or invoke a model.

## Prerequisites

Node with type stripping, Pi, Git, and JJ must be on `PATH`. Live runs additionally require configured provider credentials. The harness captures each command's version without a shell.

## Run

```bash
# No Pi process or model call; validates fixtures, schema, preservation, and reports
node --experimental-strip-types evals/workspace-skill/run.ts --dry-run --seed demo --trials 2

# Explicit live run (five-minute per-case default timeout)
node --experimental-strip-types evals/workspace-skill/run.ts --seed demo --trials 1 --provider <provider> --model <model> --thinking medium --timeout-ms 300000
```

Live Pi runs in JSON mode without a saved session or fixture context files, with discovered extensions and skills disabled. The `-e` distribution and `--skill` resources are resolved absolute paths. The timeout is bounded; partial output, reports, and failed/timed-out fixtures are retained. Specification-only cases are always skipped. Successful and skipped fixtures are removed; failed fixtures remain at the reported recovery path.

## Artifacts

Each `reports/<run-id>/` contains:

- `summary.md` — human-readable disposition and retained paths
- `results.json` — run metadata and all case results (`report.json` is retained for compatibility)
- `commands.jsonl` — one JSON object per tool trace event
- `cases/<case-id>-<trial>.json` — complete per-case result

Reports include run/case seeds, deterministic fixture manifests, model/provider/thinking (or `null`), deterministic skill hash, Pi/JJ/Git versions, timings, full captured tool traces and streams, final visible assistant output, usage when emitted, assertion results, and retained failure paths. Missing live metadata is recorded as `null`, not inferred.

## Coverage and grading

YAML cases cover JJ preference, explicit Git routing, dirty sibling isolation, explicit JJ `-r @`, safe refusal to force-remove dirty Git work, and a purpose-built completed-planner specification. Executable routing cases require a trace read of the selected JJ/Git reference. The planner regression is always `specification-only` because a standalone fixture cannot synthesize Pi's managed subagent record.

Primary grading independently inspects backend commands, selected reference reads, prohibited commands, exact source revision/status/diff preservation, repository topology, recoverability, explicit paths, and final reporting. Dirty-source exclusion checks only newly created topology paths, never arbitrary model-reported paths.

Seeds are SHA-256-derived per case/trial. Generated content and state reproduce from the seed: nested safe paths, stable variable history length, deterministic Git commit timestamps/revision IDs, committed files, and representative untracked plus Git staged/unstaged state where applicable. `fixture.json` and report manifests record paths, hashes, revisions, state, auxiliary recovery paths, and preservation rules. Wall-clock run IDs and report timestamps intentionally vary.

## Limits

Dry run does not grade model traces or behavior; executable cases pass on fixture/schema/preservation checks only. Usage and observable model identity depend on the provider's JSON events. Live behavior remains provider/model dependent.
