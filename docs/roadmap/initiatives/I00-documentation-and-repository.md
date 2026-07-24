# I00 — Documentation and repository alignment

**Status:** Planned  
**Depends on:** none

## Outcome

The replacement documentation becomes normative, historical docs are retired, and every top-level repository area is classified as core product, client, Host infrastructure, experiment, generated output, or removal candidate.

## Scope

- Review and adopt `tmp/docs` into the project docs root.
- Reconcile README terminology and repository layout.
- Preserve only enduring decisions from the legacy archive.
- Stop shipping obsolete documentation in the Pi package.
- Define package/release inclusion explicitly.
- Stop tracking generated desktop bundles unless a documented packaging constraint requires them.
- Classify every crate/package/app/service against the target architecture.
- Record merge/remove decisions for proof-era Host layers.

## Exit criteria

- All internal docs link to one indexed normative tree.
- No active document conflicts with Host-authoritative session persistence.
- Concurrency/JJ documents retain all accepted invariants and test requirements.
- Root README points to product, architecture, concurrency, and roadmap indexes.
- Package dry-run contains only intended user/contributor documentation.
- Legacy docs can be deleted without losing an active decision.
