# Workspace custody registry

## K7b: SQLite authority (landed)

Managed JJ workspace authority now lives in the versioned XDG-state SQLite database. Production constructs `SQLiteWorkspaceManager` over `SqliteWorkspaceCustody` and runs coordinator recovery before workspace tools are available. Database and storage directories are private (`0600` and `0700`). Two root sessions sharing a repository are partitioned by durable `rootSessionId`; a root cannot mutate another root's records.

`workspaces.json` is legacy input only. Production neither creates nor writes it, and no production composition imports or constructs `FileWorkspaceRegistry`. A valid v2 file is digest-verified into the migration directory, imported as attention-required incident custody, receipted, and retired by a digest-qualified rename. The verified bytes and managed checkout paths are preserved. The migration ledger makes restart idempotent. Invalid v1, malformed, ambiguous, colliding, corrupt, or newer-schema data is quarantined/fails closed rather than being guessed into authority.

SQLite startup integrity and schema checks fail closed. If custody storage is unavailable, shared subagent isolation remains usable, while workspace operations return a bounded remediation message naming the XDG state directory and `state.sqlite3`. Shutdown waits for child settlement before closing the database; a later session/tool use safely reopens it.

Create, sweep, merge, and discard are coordinator transactions with durable intent and receipts. Startup recovery completes or safely retains interrupted operations before tools run. Tree/reload hooks reattach lifecycle state; settlement reclaims only empty workspaces. Dashboard rendering does not invoke JJ.

When a merge creates conflicts, the source workspace and custody record remain as a recovery copy (`retained_conflicts`). Resolve the target and retry: retry proves retained heads are ancestors and conflicts are gone before detaching. Discard is explicit and records the abandoned changes. Neither path relies on an idempotent rebase.

## Migration and recovery paths

1. Keep legacy files and managed checkout directories unchanged before upgrade.
2. Start Pi-Tai with a private, writable XDG state/data root. Successful v2 migration leaves a verified copy, receipt, ledger row, and digest-qualified retired source.
3. Use `workspace_status` for imported attention incidents. Prove repository identity and recover or discard explicitly; never infer authority from a display owner.
4. For database corruption, unavailable storage, or a schema newer than this binary, preserve the reported/quarantined files and use a compatible binary or restore a backup. Do not recreate `workspaces.json` as authority.
