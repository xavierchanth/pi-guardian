# I00 — Documentation, repository, and toolchain alignment

**Status:** In progress  
**Depends on:** none

## Outcome

The canonical documentation tree, repository classification, package boundaries, and deterministic engineering gate stay explicit and enforceable. Product documentation remains future-first while source and tests define exact released behavior.

## Current gap

The indexed documentation tree is established, obsolete competing plans have been retired, and Real-JJ fixtures use isolated deterministic configuration. Biome now enforces the initial concurrency/JJ formatting and lint boundary, CI runs the full gate plus package and isolated smoke checks, and the complete current component inventory is classified in [Repository shape](../../architecture/REPOSITORY.md). I00 remains in progress because broker/session-service ownership, persisted-versus-wire event coupling, proof-era Host layer merges, and the `packages/pi-tai` extraction remain bounded decisions assigned to I01/I02/I04/I10.

## Scope

- Keep root and documentation indexes aligned with canonical terminology and repository layout.
- Define package/release inclusion explicitly and exclude obsolete or generated documentation.
- Stop tracking generated desktop bundles unless a documented packaging constraint requires them.
- Classify every crate, package, application, and service against the target architecture.
- Record merge/remove decisions for proof-era Host layers.
- Add and enforce repository formatting, linting, and CI rules.

## Toolchain and hygiene

These are independent of every cutover and can proceed concurrently with any other initiative.

### Formatter and linter adoption

Delivered for `concurrency/` and `jj/` with pinned Biome and mechanical initial formatting. The gate checks both formatting and linting. Adoption outside those subtrees remains incremental so future mechanical changes stay reviewable.

### CI gate

Delivered in `.github/workflows/ci.yml`: the repository gate, package dry-run, and isolated extension smoke run with repository-pinned Node and Rust versions. npm's cache is keyed by the lockfile; generated and build output is not cached or tracked.

## Exit criteria

- All internal docs link to one indexed normative tree.
- No active document conflicts with Host-authoritative session persistence.
- Concurrency/JJ documents retain all accepted invariants and test requirements.
- Root README points to product, architecture, concurrency, and roadmap indexes.
- Package dry-run contains only intended user/contributor documentation.
- No obsolete or competing documentation ships as an active authority.
- A formatter and linter are configured and enforced; `concurrency/` and `jj/` are reformatted.
- CI runs `just check` on every change.
- No active document describes behavior that does not exist in code.
