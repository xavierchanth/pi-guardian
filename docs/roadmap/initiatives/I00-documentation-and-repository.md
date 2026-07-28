# I00 — Documentation, repository, and toolchain alignment

**Status:** In progress  
**Depends on:** none

## Outcome

The canonical documentation tree, repository classification, package boundaries, and deterministic engineering gate stay explicit and enforceable. Product documentation remains future-first while source and tests define exact released behavior.

## Current gap

The indexed documentation tree is established, obsolete competing plans have been retired, and Real-JJ fixtures use isolated deterministic configuration. Remaining work is repository engineering: classify proof-era Host layers, enforce package contents, add formatting and linting, and run the deterministic gate in CI.

## Scope

- Keep root and documentation indexes aligned with canonical terminology and repository layout.
- Define package/release inclusion explicitly and exclude obsolete or generated documentation.
- Stop tracking generated desktop bundles unless a documented packaging constraint requires them.
- Classify every crate, package, application, and service against the target architecture.
- Record merge/remove decisions for proof-era Host layers.
- Add and enforce repository formatting, linting, and CI rules.

## Toolchain and hygiene

These are independent of every cutover and can proceed concurrently with any other initiative.

### Add a formatter and linter, then reformat `concurrency/` and `jj/`

No TypeScript formatter or linter is configured. Add one deterministic toolchain and apply it to the dense concurrency and JJ modules before enforcing it repository-wide. Keep this mechanical change separate from behavior changes so review remains meaningful.

### Add CI running `just check`

There is no `.github/` directory. `npm run check` already chains `protocol:check → typecheck → test → test:rust`. For a project whose premise is agent-generated changes gated by deterministic checks, having the gate and not running it automatically is a conspicuous hole.

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
