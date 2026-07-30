# I17 — Researcher capability subagent

**Status:** Complete  
**Depends on:** —

## Outcome

External research is performed by a specialized Codex subagent rather than by root-session
`web_search` and `web_fetch` tools. `subagent_spawn` gains an orthogonal capability selector:

```ts
capability?: "researcher"
```

A capability alias selects required harness behavior, default model policy, specialized instructions,
and an availability probe. It does not replace either the backend/harness selector or model selection.
The category is extensible, but only `researcher` is in scope now. Browser and computer capability
aliases and adapters are deferred.

## Decisions

### Three orthogonal selectors

`subagent_spawn` retains `backend`, `model`, and `effort` and adds `capability`.

- **Capability** says what specialized work and tool contract the child has.
- **Backend** says which harness executes it.
- **Model** says which provider/model performs the reasoning.

`researcher` requires the `codex` backend and supplies a default model. An explicit compatible model
or effort may override its default. An explicit incompatible backend is rejected rather than silently
degrading to a general-purpose child.

Resolution order is:

1. explicit spawn values;
2. capability requirements and defaults;
3. model-alias defaults;
4. backend defaults.

The existing spawn-boundary behavior that forces an omitted backend to `pi` before resolving a model
alias is corrected as part of this work. Omitted selectors allow the narrowest selected alias to choose
its backend.

### Versioned capability catalog

Create a packaged, versioned capability catalog beside `models.json`. Its exact-key parser follows the
model catalog trust-boundary pattern. The researcher entry records its name, purpose, required backend,
default model alias, specialized instruction asset, and native capability requirement.

Instructions live in packaged Markdown rather than JSON. Validation rejects invalid or duplicate names,
unknown backends/models/requirements, incompatible model/backend pairs, and missing instruction assets.

### Truthful Codex availability

Codex app-server natively supports research. The backend must:

1. initialize successfully;
2. return `webSearch: true` from `modelProvider/capabilities/read`;
3. permit `live` under `configRequirements/read.requirements.allowedWebSearchModes`; and
4. accept `thread/start.config.web_search: "live"`.

Every researcher thread explicitly requests live search rather than inheriting machine-local Codex
configuration. Native `webSearch` items remain visible through the neutral event stream so progress and
failures are inspectable.

### Root web-tool replacement

Stop registering `web_search` and `web_fetch` as root tools and remove them from Pi children so research
consistently crosses the researcher boundary. Prompt guidance directs the parent to spawn a researcher,
continue it for related follow-up research, and consume its sourced report.

Delete the existing web implementation once repository-wide checks prove it has no production callers.
Remove Guardian's `web_fetch` handling only where unreachable; do not weaken unrelated security policy.

The researcher uses the existing lifecycle, four-child concurrency limit, result delivery, cancellation,
and continuation machinery. Its capability is retained in the snapshot so continuation cannot silently
change specialization.

## Implementation checkpoints

### 1. Catalog and spawn contract

- Add the capability catalog, researcher instruction asset, exact parser, and resolver.
- Add `capability` to the spawn schema and neutral spawn/snapshot types.
- Compose researcher instructions into the child charter.
- Define override and continuation validation.
- Correct model-alias/backend resolution at the tool boundary.
- Test catalog validation and resolution precedence.

### 2. Codex research protocol

- Add typed requests/responses for `modelProvider/capabilities/read` and `configRequirements/read`.
- Add a structured backend capability-probe contract.
- Configure researcher threads with `web_search: "live"`.
- Map native `webSearch` items into useful neutral progress events.
- Test supported, disabled, policy-restricted, malformed, and unavailable cases.

### 3. Exposure cutover and documentation

- Remove direct web-tool registration and the Pi-child web tools.
- Delete dead web modules and dependencies after reference checks.
- Revise Guardian surfaces where `web_fetch` becomes unreachable.
- Update prompt guidance, exact tool-surface tests, package contracts, README, settings, concurrency
  documentation, glossary, and capability architecture documentation.
- Add an isolated-distribution test using `pi -ne -e .` that verifies sourced research delegates to a
  researcher.

## Delegation plan

Implement sequentially in isolated workspaces:

1. catalog/resolver and spawn contract;
2. Codex app-server research probing and live-search configuration;
3. direct-tool cutover, dead-code removal, documentation, and distribution verification.

The combined result receives independent review focused on resolution precedence, truthful availability,
protocol compatibility, citation behavior, and security-check removal.

## Out of scope

- `browser_user` and `computer_user` aliases.
- Browser or desktop automation adapters.
- Recursive subagent delegation.
- Replacing the general-purpose subagent lifecycle with a dedicated researcher tool.
- Host-persisted browser/computer ownership, credentials, takeover, and artifacts; those remain I12.

## Exit criteria

- Root sessions no longer expose `web_search` or `web_fetch`.
- `subagent_spawn(capability: "researcher", ...)` runs through Codex with explicitly enabled live
  native web search and produces a bounded sourced report.
- Startup fails clearly when native search is absent or forbidden by policy.
- Explicit compatible model/effort overrides work; incompatible backend overrides fail.
- Continuation preserves the researcher contract.
- Existing ordinary subagent behavior and concurrency remain intact.
- Unit, repository, Codex protocol, and isolated-distribution tests pass.
