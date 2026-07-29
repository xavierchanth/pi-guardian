# I13 — Host configuration authority

**Status:** In progress  
**Depends on:** I02, I03

## Outcome

Configuration terminates at the Host. Policy is resolved once, pinned into the session aggregate as
an event, and never re-read from the filesystem by a running worker. Every resolved field carries
provenance; privileged fields cannot be set by a project. Guardian's reviewer model and timeout
become explicit machine configuration; high/critical outcomes remain fixed safety invariants.

## Current gap

Checkpoints 6 and 7 ended the Host/runtime configuration split. A Host-managed session now resolves
policy before worker startup, emits one durable `session.policy_resolved` event, reconstructs policy
from replay, and rejects a worker session that lacks pinned policy and provenance. Editing a
configuration file cannot alter an existing session; it affects only sessions created afterward.

I13 remains incomplete in four areas:

1. session policy is pinned but cannot yet be changed through a revision-guarded command and event;
2. project trust is a temporary client assertion rather than a Host-owned, digest-bound decision;
3. project agent definitions can still widen a packaged or user definition;
4. Guardian's reviewer model and timeout remain hardcoded rather than explicit privileged Host
   machine configuration.

Configuration remains the forcing function for I01. While the direct Pi extension is both client
and harness, `packages/pi-tai/src` can remain both core and adapter. Configuration exposes where
Pi's ownership is load-bearing rather than incidental: `getAgentDir()`, project trust,
`session_start`, credentials, model catalogs, and keybindings.

## Decisions

Decisions are numbered `D<n>` and referenced by implementation handoffs. Do not reopen without new
information.

### D4 — Resolve once, pin into the session aggregate

Session creation emits a `session.policy_resolved` event carrying the fully resolved policy
document plus provenance. The runtime worker receives it in `SessionCreateParams` and **never opens
a configuration file**. Subsequent changes are commands (`session.set_policy`) producing events —
never file re-reads.

Consequences: replay reconstructs a session including the policy it ran under; mid-session file
edits cannot silently change a running session; the `agentDir` ambient global is eliminated. It
currently appears as a defaulted parameter in roughly 20 call sites, including `config/paths.ts:6`,
`subagents/register.ts:110`, `concurrency/child-session.ts:92` and `:109`,
`concurrency/coordinator.ts:74`, `pi-tai.ts:118`. Under pinning, the few components that genuinely
need a filesystem root receive it explicitly in the resolved policy; nothing else receives it.

### D5 — Provenance on every resolved field

```ts
export interface FieldOrigin {
  readonly layer: "default" | "machine" | "user" | "project";
  readonly path?: string;
  readonly digest?: string;  // content digest of the layer that supplied this value
}
```

This buys three things at once: a `/config explain` surface that behaves identically in Zed and T3;
an audit trail for security-relevant fields; and the ability to reject project-sourced values for
privileged fields **structurally** rather than by convention. The digest is reused by D8 for trust
binding, so it is not additional bookkeeping.

### D6 — Three configuration planes with enforced ownership

`PiTaiConfig` originally placed terminal escape codes beside token-spending policy. It splits into
three types with three lifetimes:

| Plane | Owner | Lifetime | Storage |
|---|---|---|---|
| `HostMachineConfig` | Host | Machine, long-lived | Host-owned file, admin-writable |
| `SessionPolicy` | Host | Per session, command-mutable | Session aggregate, event-sourced |
| `ClientPreferences` | Client | Client-local | Each client's own storage; never crosses the wire |

Field-by-field disposition:

| Original field | Destination | Note |
|---|---|---|
| `ansiTheme` | `ClientPreferences` — retained in the Pi client adapter | Zed and T3 own their own theming |
| `notifications` | `ClientPreferences` — retained in the Pi client adapter | ACP `session/update` supplies events; each client decides how to notify |
| `cmux` | `ClientPreferences` — retained in the Pi client adapter | Reporting-only integration; agent-driven cmux control belongs to I12 |
| `modelProfiles` | **Split**: list → `SessionPolicy`; cycling keybinding → `ClientPreferences` | See D7 |
| `sessionTitle` | `SessionPolicy`, **privileged** | Selects a model and spends tokens |
| `compaction` | `SessionPolicy`, unprivileged | Pure agent behavior |
| Guardian reviewer model / timeout | `HostMachineConfig`, **privileged** | Currently hardcoded at `guardian/reviewer.ts:18-19` |
| Agent definitions + precedence | `HostMachineConfig` roots + `SessionPolicy` selection | Trust model must move; see D8 |
| Credentials / model catalog | `HostMachineConfig` | Replaces `auth.json`, `models.json` |

Enforcement: every field carries `scope: "machine" | "project" | "session"` and
`privileged: boolean`. The resolver refuses project-layer values for privileged fields. Previously
that entire rule was one prose sentence in `SETTINGS.md` plus one boolean at `config/load.ts:43`,
which is why `sessionTitle.provider`/`model` was settable from a trusted project file — a cloned
repository could point title generation at a model of its choosing.

**`modelProfiles` is privileged** [Decided 2026-07-25, extending D6, which left it untagged]. It
selects the provider and model for the main work loop, so a cloned repository could otherwise route
real coding prompts to a provider of its choosing. It is treated as a single field rather than
per-entry because the loader replaces the array wholesale.

### D7 — Shape the session policy to ACP, not to a generic contract

`bins/acp/src/app.ts:23` advertises `capabilities: {}` with the comment "Do not advertise the
session surface until every v2 baseline method is wired." The session surface is entirely unwired,
so nothing constrains the design.

ACP already provides the vocabulary. [Confirm exact shapes against the pinned v2 draft in
`fixtures/acp-v2/pin.json` and `@agentclientprotocol/sdk/experimental/v2` before relying on them.]

| ACP concept | Maps to |
|---|---|
| Session modes (`SessionModeState`; `session/set_mode`) | `modelProfiles` |
| Available commands | `/effort`, `/subagents`, `/capabilities` |
| Model selection (`session/set_model`) | Profile provider/model |
| `session/request_permission` | Guardian non-allow, if D10 enables it |
| Agent-owned terminal updates | Host-owned shell execution projected to clients; see O1 |

Therefore the profile type matches structurally:

```ts
export interface Profile {
  readonly id: string;           // → ACP mode id
  readonly name: string;         // → ACP mode name
  readonly description?: string; // → ACP mode description
  readonly provider: string;
  readonly model: string;
  readonly effort: ThinkingEffort;
}
```

`SessionPolicy` carries `profiles` and `currentProfileId`, which is `SessionModeState` almost
exactly, so the ACP adapter becomes a projection rather than a translation layer.
`DEFAULT_MODEL_PROFILES` (`sol-low`, `sol-medium`, `sol-high`) maps on with no loss; cycling *order*
becomes array order a client may or may not use.

Consequence: Shift+Tab cycling stops being pi-tai's concern, removing the behavior of writing into
the user's `~/.pi/agent/keybindings.json`.

**Risk:** under ACP the *client* may serve `fs/read_text_file`, including unsaved editor buffers.
Guardian's canonical-path boundary (`guardian/paths.ts`) assumes the filesystem is ground truth.
Analyze this before enabling the ACP file surface.

### D8 — Project trust moves to the Host, digest-bound and per-field

`ctx.isProjectTrusted()` is Pi's. With no Pi, the Host needs its own trust store keyed on canonical
repository path. Two things change rather than port as-is:

**Trust the content, not just the path.** Trusting a project once currently trusts every future edit
of `.pi/pi-tai.json` and `.pi/agents/*.md`. Record the layer digest (already required by D5) and
re-prompt when it changes. This matters more under an editor client than a CLI: Zed opens arbitrary
repositories routinely, and the CLI's "you `cd`'d here deliberately" assumption does not survive.

**Project agent definitions may only narrow.** Trusted nearest-project `.pi/agents` definitions
currently have *highest* precedence, and agent front matter carries an explicit `tools:` list
(`packages/pi-tai/agents/orchestrator.md:8-30`), so a cloned repository can redefine `worker` with a
wider tool set. At that time Guardian reviewed `bash` and `web_fetch` but not the composition, and not
`write`/`edit`. The resolver must enforce that a project-layer agent definition is a subset of the
same-named user or packaged definition's tools — never a superset — and may never set `root: true`.

This concern is currently moot: declarative agent definitions were removed along with named roles, so
there is no `.pi/agents` layer to resolve and no per-agent `tools:` list to narrow. The requirement
stands if project-layer agent definitions are ever reintroduced.

### D9 — Schema and resolution in Rust

| Option | Verdict |
|---|---|
| Worker resolves, Host stores | **Rejected.** The worker remains authoritative; status quo with extra steps. |
| Host passes raw layers to the worker; worker returns a resolved doc; Host pins it | **Rejected.** The Host commits a document it cannot independently validate, and every policy question requires a live worker. |
| Schema and resolution in Rust, TypeScript types generated | **Chosen.** |

The codegen pipeline already exists and is enforced: `crates/runtime-protocol/src/bin/export-bindings.rs`
uses specta, is wired to `npm run protocol:generate` / `protocol:check`, and `protocol:check` is the
first step of `npm run check`. The cost is reimplementing a shallow merge — `loadPiTaiConfig` is a
spread over four layers, not a complex algorithm.

Properties of the current loader to preserve in the port: pure apart from reading supplied layers;
warnings rather than throws for invalid values; frozen defaults; invalid values ignored rather than
fatal. Target signature, taking contents rather than paths so it is testable without a filesystem:

```rust
fn resolve(layers: &[ConfigLayer], trust: &ProjectTrust) -> (SessionPolicy, Vec<Warning>)
```

### D10 — Guardian reviewer selection becomes explicit configuration

There is **no** interactive approval path in the code. `README.md` and `SETTINGS.md` both describe
the released never-ask behavior: related high/critical actions are returned for direct human
execution, not approved and resumed through the agent. ACP permission UI may present a separate
human-owned capability flow, but it cannot authorize an agent to execute the blocked action.

Decision: configure reviewer selection and timeout, not the safety outcome. High/critical actions
remain structurally non-executable by agents; unrelated or unclear actions remain denied without a
runnable command.

| Field | Plane | Default | Note |
|---|---|---|---|
| `guardian.reviewerModel` | `HostMachineConfig`, privileged | pinned | Currently hardcoded |
| `guardian.timeoutMs` | `HostMachineConfig`, privileged | `30_000` | Currently hardcoded |

`resolveReviewerModel` (`guardian/reviewer.ts:47-59`) falls back `codex-auto-review` →
`gpt-5.4-mini` → `gpt-5.4`, silently changing the security reviewer between machines. It must become
pinned configuration that fails loudly.

## Checkpoints

| # | Checkpoint | Risk | Depends on | Acceptance boundary |
|---|---|---|---|---|
| 1 | **[Complete]** Align roadmap and initiative scopes | None | — | I01–I04 and I10 consistently describe ACP, the Pi client feasibility gate, and Host policy authority |
| 2 | **[Complete]** Replace the implicit optional-config runtime discriminator | Low | — | Runtime mode is explicit and tests cover `pi-cli`, `host-worker`, and the named legacy child-process compatibility path |
| 3 | **[Complete]** Split `SessionPolicy`, `HostMachineConfig`, and client-local preference types while preserving the current loader | Low | 1 | Existing behavior unchanged; Pi themes and notifications are client-only |
| 4 | **[Complete]** Add provenance, digests, scope, and privileged tags; reject privileged project values | Low | 3 | Every resolved policy field is explainable and project privilege tests fail closed |
| 5 | **[Complete]** Implement the pure Rust resolver and generated TypeScript bindings | Medium | 4 | Fixture/differential tests agree with preserved loader behavior; invalid values warn rather than abort |
| 6 | **[Complete]** Host resolves policy and the runtime protocol carries it | Medium | 5, I03 protocol foundation | Host calls the resolver and sends resolved policy plus provenance |
| 7 | **[Complete]** Cut configuration authority over to the Host | High | 6 | Worker opens no config files; `session.policy_resolved`, replay, and mid-session-edit tests prove one authority |
| 8 | Add revision-guarded `session.set_policy`; make profile and effort changes commands | Medium | 7 | Commands/events replay deterministically and reject stale revisions |
| 12 | Make Guardian reviewer configuration explicit (D10) in a separate change | Security-sensitive | 7; separate from 7 | Reviewer model is pinned, timeout is configured, and high/critical outcomes remain non-configurable |
| 13 | Replace asserted project trust with Host-owned trust and agent narrowing (D8) | Security-sensitive | 7 | Trust is digest-bound; project agents cannot widen tools or become root; clients cannot assert trust |

Checkpoints 9–11 (ACP modes/models/commands/permissions, the Pi interactive-session backend seam,
and `pi-tai-client` productization) belong to I04 and I10 and are tracked there.

**Checkpoint 7 ended dual authority.** Checkpoints 3–6 prepared and proved that cutover without
changing the authority owner early.

**Scope note on checkpoint 6 [Decided].** Checkpoint 6 made the Host the resolver rather than only
extending the transport. The alternative — transport-only in 6, Host resolution plus worker cutover
plus replay proof in 7 — was rejected because it loaded three independent risks into one high-risk
checkpoint. Moving Host resolution earlier reduced checkpoint 7 to deleting the worker's filesystem
branch and proving replay.

The delivered bridge carries a client-asserted trust flag on the Host create request, replacing
Pi's in-worker `ctx.isProjectTrusted()`. This is **trust on assertion**, not the end state;
checkpoint 13 replaces it with the Host-owned, digest-bound store.

As shipped, both clients hardcode the assertion to `false` (`bins/acp/src/host-port.ts:62`,
`bins/ctl/src/main.rs:87`), so a Host-managed session never applies project-layer configuration. The
flag is exercised true only in tests until D8. This is fail-closed and intended — D8 should treat it
as the starting point, not discover it as a regression.

**Binding constraint:** migration rule 4 forbids combining broad repository moves with
security-sensitive behavior changes. Checkpoints 12 and 13 remain separate from broad refactors and
from one another.

## Resolved inputs

| # | Decision |
|---|---|
| O1 | Shell execution is Host-owned and passes through Guardian before side effects. The process may run in a Host-supervised worker/adapter, but clients only receive ACP terminal projections. Approved commands continue across client disconnects unless explicitly cancelled. Interactive/PTY commands are out of scope. Clients may display terminal output but receive no stdin takeover or execution authority. |
| O2 | The temporary orchestration/recovery workspaces and branches are gone. No preservation work is required. |
| O3 | T3 Code uses ACP. Integration details may be decided later; ACP is the common client boundary. |
| O4 | Use XDG Base Directory locations and keep data classes separate. Settings under `$XDG_CONFIG_HOME/pi-tai`; credentials under `$XDG_DATA_HOME/pi-tai/credentials`; other persistent data under separate paths in `$XDG_DATA_HOME/pi-tai`; durable sessions and logs under distinct paths in `$XDG_STATE_HOME/pi-tai`; disposable caches under `$XDG_CACHE_HOME/pi-tai`; ephemeral sockets/locks under `$XDG_RUNTIME_DIR/pi-tai` when available. Do not place durable sessions or credentials in cache, and do not collapse these roots into one application directory. |
| O5 | Build a separate `pi-tai-client` executable using a Pi interactive-session backend seam and ACP; retain the current direct extension during migration. Pi's interactive components and theme are public exports independent of its harness, so the expected path is composition from those exports — no fork, no upstream seam required. The smallest-maintainable-variant fallback stands if that surface proves insufficient. Implementation proof remains outstanding; tracked in I04. |

## Exit criteria

- The Host resolves policy and pins it into the session aggregate; no worker opens a configuration
  file for a Host-managed session.
- Replay reconstructs a session including the policy it executed under.
- A mid-session edit to any configuration file cannot alter a running session.
- Every resolved field reports its layer, path, and digest.
- A trusted project cannot set any privileged field; each attempt warns once naming the field.
- A project agent definition can only narrow the same-named user or packaged definition, and cannot
  set `root: true`.
- Guardian's reviewer model and timeout are pinned configuration that fails loudly; high/critical
  outcomes remain fixed and cannot be weakened by machine, project, session, or client settings.
- The `agentDir` ambient global is gone from every call site.
