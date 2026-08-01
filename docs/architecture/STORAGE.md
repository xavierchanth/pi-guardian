# Durable storage

## K7b status

K7b is landed for workspace custody. Production composition opens the versioned SQLite database under the private XDG state root, runs recovery before exposing workspace tools, and constructs `SQLiteWorkspaceManager`; `workspaces.json` is no longer runtime authority and is never written. Subagent lifecycle records remain a separate concern.

Pi-Tai resolves its paths centrally under the XDG state, data, cache, and runtime roots. On systems without `XDG_RUNTIME_DIR` (normally macOS), runtime files use the private `$XDG_CACHE_HOME/pi-tai/run` fallback, never `/tmp`. Directories are mode `0700`; files are `0600`; writable-by-group/other roots and symlink roots are refused. Configuration remains exclusively in Pi configuration and is never stored in this database.

The versioned SQLite database uses built-in `node:sqlite`, WAL, `synchronous=FULL`, foreign keys, trusted-schema disabling, a busy timeout, startup integrity checking, corruption quarantine, and constrained/indexed metadata tables. It contains no report prose or image bytes. Session and artifact path keys exist, but report/image stores do not.

The M0 legacy migration copies child session data from `~/.pi/agent/pi-tai`, fsyncs and SHA-256 verifies each copy, records a receipt and legacy breadcrumb, and is resumable. K7b additionally imports valid custody-v2 `workspaces.json` records as attention-required incidents. It first keeps a digest-verified `0600` migration copy and receipt, then retires the original by digest-qualified rename; it never changes workspace contents or paths. Restart recognizes the migration ledger and does not duplicate records. Invalid, ambiguous, colliding, corrupt, or newer input remains quarantined/recoverable rather than becoming authority. Context exports remain out of scope.
