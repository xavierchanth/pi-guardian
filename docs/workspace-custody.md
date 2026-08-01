# Workspace custody registry

Managed JJ workspaces are recorded in `workspaces.json` using custody schema v2. Each record has a durable, opaque `ownerId` and the `rootSessionId` of the top-level session. Human-facing `sa-N` values belong only in `ownerDisplayId`; they are not authority because they repeat in different roots.

Create, sweep, merge, and discard hold one cross-process operation lock for the complete registry-and-repository transaction. Registry JSON replacement additionally uses its shorter RMW lock. Lock order is operation lock then registry lock. Contention is bounded; malformed, young, or unverifiably stale locks are never stolen.

A root must never mutate records belonging to another root. Version 1 records have no durable authority and are quarantined for manual migration or recovery. Unknown managed JJ attachments are likewise retained for inspection.

When a merge creates conflicts, the source workspace and registry record remain as a recovery copy (`retained_conflicts`). After resolving the target, retry merge. The retry first proves every retained source head is already an ancestor of the target and verifies that conflicts are gone; only then does it detach the source and remove the record. It does not depend on an idempotent rebase.

## Migration

Do not infer v2 authority from a v1 display owner. Inspect the repository and running root, then either recover the work manually or create a v2 record with a known durable `rootSessionId` and `ownerId`. Ambiguous records must remain quarantined.
