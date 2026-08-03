# I18 — Context transfer (retired)

**Status:** Retired

## Decision record

Pi-Tai previously added dedicated `/context-export` and `/context-import` commands after subagent work suggested an explicit session-handoff workflow. The user never adopted the commands and explicitly decided to remove the feature rather than maintain an unused parallel to Pi's own facilities.

The command registration, custom renderer, domain and storage implementation, composition wiring, public exports, and feature-specific tests were removed. Upstream Pi `/export` and `/import` are unchanged.

Historical local artifacts are not migrated or deleted. Existing private Pi-Tai state remains subject to Guardian's conservative handling, and legacy migration continues to leave unknown retired data in place. This is retention for safety, not a supported interface or an active roadmap commitment.
