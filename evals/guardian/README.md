# Guardian review fallback eval cases

This suite records fully synthetic actions for evaluating what should happen when automatic Guardian review times out, is cancelled, or fails at the provider. It is a policy corpus: the expected disposition says whether the action should proceed during review unavailability, not whether the original tool execution succeeded.

## Validate

```bash
npm run eval:guardian
```

The validator checks the strict schema, unique IDs, and sanitation requirements. It rejects timestamps, detailed managed-workspace paths, machine-specific absolute paths, opaque source identifiers, and non-reserved URL hosts. It does not execute any recorded command or claim that the current Guardian implementation satisfies the expected dispositions.

## Case semantics

Each case contains:

- `reviewFailure`: the review-unavailability class, without timestamps;
- `action`: the proposed tool call;
- `expected.classification`: the action class used by the policy oracle;
- `expected.disposition`: `allow` for ordinary activity or `block` when unavailable review leaves unacceptable destructive uncertainty;
- `expected.rationale`: the concise basis for that disposition.

Every action is a synthetic representative rather than a copied incident. Paths, identifiers, commands, code fragments, package names, service names, and project details from source activity are not retained. Managed workspace paths are normalized to exactly `.jj/workspaces`.

The corpus currently expects ordinary reads, tests, edits, remote reads, and recoverable checkpoints to proceed. Recursive filesystem deletion and unproved JJ abandonment must stop when review is unavailable.
