# Durable storage

## Stage S0 status

S0 establishes storage substrate only; it does **not** flip authority. The production subagent manager remains wired to `InMemoryRecordStore`, and existing workspace custody remains in place. The SQLite adapter is available for tests and later S1 integration.

Pi-Tai resolves its paths centrally under the XDG state, data, cache, and runtime roots. On systems without `XDG_RUNTIME_DIR` (normally macOS), runtime files use the private `$XDG_CACHE_HOME/pi-tai/run` fallback, never `/tmp`. Directories are mode `0700`; files are `0600`; writable-by-group/other roots and symlink roots are refused. Configuration remains exclusively in Pi configuration and is never stored in this database.

The versioned SQLite database uses built-in `node:sqlite`, WAL, `synchronous=FULL`, foreign keys, trusted-schema disabling, a busy timeout, startup integrity checking, corruption quarantine, and constrained/indexed metadata tables. It contains no report prose or image bytes. Session and artifact path keys exist, but report/image stores do not.

The M0 legacy migration copies child session data from `~/.pi/agent/pi-tai`, fsyncs and SHA-256 verifies each copy, records a receipt and legacy breadcrumb, and is resumable. It never moves or deletes source data. In particular, managed jj workspaces remain at their registered absolute paths, `workspaces.json` remains for S1, and context exports are out of scope. Plans above 256 MiB require explicit confirmation. This preserves downgrade access to the complete legacy tree.
