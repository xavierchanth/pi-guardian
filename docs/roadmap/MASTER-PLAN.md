# Master plan — Host configuration authority and client cutover

## 0. How to use this document

This is a handoff. It encodes decisions already made, the reasoning behind them, and the work
that follows. A planner picking this up should **not re-litigate Part 2 or Part 3 decisions**;
they were reached deliberately and their rationale is recorded. Parts 6 and 7 are independent
work lists. Part 8 is the only place where user input is still required.

Claim types are marked throughout:

- **[Verified]** — checked against the repository or a command run on 2026-07-25.
- **[Decided]** — a decision made in this planning cycle. Rationale recorded; do not reopen without new information.
- **[Recommended]** — a proposal that a planner may refine.
- **[Unverified]** — an assumption that must be confirmed before it is relied on.

This document is roadmap content per `docs/README.md` rule 2: it contains status, sequencing,
and migration constraints, and it describes the delta from the current repository to the
intended system. It supersedes the scope of initiatives I01, I04, and I10 as described in
`README.md`; see Part 5.4.

---

## 1. Current state

### 1.1 What the repository is today

**[Verified]** `pi-tai` is a Git-installable Pi distribution — a TypeScript extension loaded
into the Pi CLI (`package.json` `"pi"` key, `"keywords": ["pi-package"]`), plus a Rust Host
workspace, a Tauri desktop shell, and an ACP adapter.

| Area | Size | State |
|---|---|---|
| `packages/pi-tai/src` (TS domain + adapter) | ~15,400 lines | All domain logic lives here |
| Total tracked TS/TSX | ~27,300 lines | |
| `crates/` (Rust Host) | ~6,500 lines | Idiomatic, tested |
| Tracked files | 342 | |
| Unit tests | 220, all passing, ~10s | `npm run test:unit` |
| Typecheck | Clean | `npm run typecheck` |

**[Verified]** Roadmap status at time of writing: I00 Planned, I01 Planned, I02 In progress,
I03 In progress, I04 Planned, I05–I09 Complete, I10 In progress, I11–I12 Exploratory.

### 1.2 Where configuration lives today

**[Verified]**

| Concern | Owner today | Location |
|---|---|---|
| Pi-Tai settings | Pi CLI, read by the extension | `~/.pi/agent/pi-tai.json`, `<project>/.pi/pi-tai.json` |
| Credentials | Pi | `~/.pi/agent/auth.json` |
| Model catalog | Pi | `~/.pi/agent/models.json` |
| Keybindings | Pi; Pi-Tai writes into it | `~/.pi/agent/keybindings.json` |
| Native settings (`defaultModel`, `theme`, `packages`, …) | Pi; Pi-Tai explicitly disclaims | `~/.pi/agent/settings.json` |
| Project trust | Pi | `ctx.isProjectTrusted()` |
| Agent definitions | Packaged < user < project-trusted | `packages/pi-tai/agents`, `~/.pi/agent/agents`, `<project>/.pi/agents` |
| Themes, skills, prompts | Pi package loader | `package.json` `"pi"` key |

**[Verified]** The resolved shape is `PiTaiConfig` in `packages/pi-tai/src/config/schema.ts`:
`sessionTitle`, `ansiTheme`, `notifications`, `compaction`, `modelProfiles`. It is resolved by
`loadPiTaiConfig` (`config/load.ts:39`) as a four-layer spread — defaults, global, project,
with `modelProfiles` replaced wholesale rather than merged — and re-read on every
`session_start` (`config/register.ts:29`).

---

## 2. Strategic decisions

### D1 — Add a Pi-derived ACP client alongside the legacy direct extension **[Decided]**

Target Host clients are **T3 Code, Zed, and the new `pi-tai-client` executable over ACP**. The
current `pi-tai` extension remains available as a separate legacy direct Pi harness during
migration. Host clients do not retain configuration, session, or execution authority and do not
embed the agent runtime.

The current Git-installable `pi-tai` extension remains available as the legacy direct Pi harness
during migration. It does not attach to Host sessions and cannot participate in cross-client
handoff; that limitation must be explicit.

Build a separate **`pi-tai-client` executable** as the Host-backed path. It is a Pi-derived TUI
whose interactive session backend is replaced by an ACP client. It connects through the ACP shim
to the Host, projects Host-owned transcript/session/tool/terminal state, and never creates a local
agent session, model loop, tool executor, or durable shadow transcript. Reuse Pi's terminal UI,
themes, editor, footer, keybindings, renderers, and notifications.

Prefer introducing a narrow interactive-session backend seam that can be maintained against Pi
or proposed upstream. If that seam cannot be supported cleanly, maintain the smallest practical
Pi variant or build the executable from Pi's SDK/TUI components. Do not emulate remote sessions
inside a stock extension by intercepting input while a hidden local `AgentSession` remains active.

### D2 — The Host is the terminus of authority **[Decided]**

Configuration, session state, and execution all terminate at the Host. The Pi SDK becomes an
implementation detail inside the Host-supervised runtime worker, not a user-facing surface.

### D3 — This is the forcing function for I01 **[Decided]**

Core extraction has been `Planned` since the roadmap was written because nothing forced it: as
long as the Pi CLI is a client, `packages/pi-tai/src` can remain both the core and the adapter.
Removing harness responsibilities from the Pi CLI leaves its adapter as a thin ACP client;
the runtime-independent domain code becomes `@pi-tai/core`. This now requires separating the
client adapter and presentation modules from core rather than deleting every Pi-facing module.

**The configuration problem and the stalled core extraction are the same problem.** Configuration
is where Pi's ownership is load-bearing rather than incidental (`getAgentDir()`,
`ctx.isProjectTrusted()`, `session_start`, `auth.json`, `models.json`, `keybindings.json`).
Everything else in the extension was written in this repository and carries no Pi dependency.

---

## 3. Configuration architecture

### 3.1 The problem being solved

**[Verified]** Configuration is resolved at `session_start`, **inside the runtime worker**, off
the filesystem:

- `services/pi-runtime/src/pi-runtime.ts:292` — `config: createPiTaiConfigService(agentDir)`
- `services/pi-runtime/src/pi-runtime.ts:245` — `authPath: join(agentDir, "auth.json")`

The runtime worker therefore holds a filesystem-derived configuration authority running in
parallel with the Host. This is the same dual-authority pattern as the `File*`/`Host*` store
pairs, but less visible because there is no second class to notice.

Two consequences are live defects today:

1. Editing `~/.pi/agent/pi-tai.json` mid-session silently changes behavior at the next session
   start, with nothing recorded.
2. `replay` cannot reconstruct a session, because it replays events but not the policy those
   events executed under. The `SESSIONS.md` promise of canonical replay is currently true only
   for message flow.

This violates `docs/README.md` rule 5 ("The Host is the sole durable session authority") and
roadmap migration rule 2 ("keep one authoritative state owner during every cutover").

### D4 — Resolve once, pin into the session aggregate **[Decided]**

Session creation emits a `session.policy_resolved` event carrying the fully resolved policy
document plus provenance. The runtime worker receives it in `SessionCreateParams` and **never
opens a configuration file**. Subsequent changes are commands (`session.set_policy`) producing
events — never file re-reads.

Consequences:

- Replay reconstructs a session *including the policy it ran under*.
- Mid-session file edits cannot silently change a running session.
- The `agentDir` ambient global is eliminated. **[Verified]** it currently appears as a defaulted
  parameter in roughly 20 call sites, including `config/paths.ts:6`, `subagents/register.ts:110`,
  `concurrency/child-session.ts:92` and `:109`, `concurrency/coordinator.ts:74`,
  `pi-tai.ts:118`. Under pinning, the few components that genuinely need a filesystem root
  receive it explicitly in the resolved policy; nothing else receives it at all.

### D5 — Provenance on every resolved field **[Decided]**

```ts
export interface FieldOrigin {
  readonly layer: "default" | "machine" | "user" | "project";
  readonly path?: string;
  readonly digest?: string;  // content digest of the layer that supplied this value
}
```

This buys three things simultaneously:

- a `/config explain` surface that behaves identically in Zed and T3;
- an audit trail for security-relevant fields;
- the ability to reject project-sourced values for privileged fields **structurally**, rather
  than by convention.

The digest is reused by D8 for trust binding, so it is not additional bookkeeping.

### D6 — Three configuration planes with enforced ownership **[Decided]**

`PiTaiConfig` currently places terminal escape codes beside token-spending policy. Split into
three types with three lifetimes:

| Plane | Owner | Lifetime | Storage |
|---|---|---|---|
| `HostMachineConfig` | Host | Machine, long-lived | Host-owned file, admin-writable |
| `SessionPolicy` | Host | Per session, command-mutable | Session aggregate, event-sourced |
| `ClientPreferences` | Client | Client-local | Each client's own storage; never crosses the wire |

Field-by-field disposition of what exists today:

| Today | Destination | Note |
|---|---|---|
| `ansiTheme` | Pi CLI `ClientPreferences` — **retain in the Pi client adapter** | Zed and T3 own their own theming |
| `notifications` | Pi CLI `ClientPreferences` — **retain in the Pi client adapter** | ACP `session/update` supplies events; each client decides how to notify |
| `modelProfiles` | **Split**: list → SessionPolicy; cycling keybinding → ClientPreferences | See D7 |
| `sessionTitle` | SessionPolicy, **privileged** | Selects a model and spends tokens |
| `compaction` | SessionPolicy, unprivileged | Pure agent behavior |
| Guardian reviewer model / timeout | HostMachineConfig, **privileged** | **[Verified]** currently hardcoded at `guardian/reviewer.ts:18-19`, not configurable |
| Agent definitions + precedence | HostMachineConfig roots + SessionPolicy selection | Trust model must move; see D8 |
| Credentials / model catalog | HostMachineConfig | Replaces `auth.json`, `models.json` |

Enforcement mechanism: every field carries `scope: "machine" | "project" | "session"` and
`privileged: boolean`. The resolver refuses project-layer values for privileged fields.

**[Verified]** Today that entire rule is one prose sentence in `SETTINGS.md` plus one boolean at
`config/load.ts:43`. A consequence worth noting: `sessionTitle.provider`/`model` is currently
settable from a trusted project file, so a cloned repository can point title generation at a
model of its choosing. Low severity, but exactly the class of thing the scope tag makes
impossible rather than merely unlikely.

### D7 — Shape the session policy to ACP, not to a generic contract **[Decided]**

**[Verified]** `bins/acp/src/app.ts:23` currently advertises `capabilities: {}` with the comment
"Do not advertise the session surface until every v2 baseline method is wired." The session
surface is entirely unwired, so nothing constrains the design. This is the highest-leverage
window available.

**[Unverified — confirm against the pinned v2 draft in `fixtures/acp-v2/pin.json` and the
`@agentclientprotocol/sdk/experimental/v2` package before relying on exact shapes.]** ACP already
provides the vocabulary being invented here:

| ACP concept | Maps to |
|---|---|
| Session modes (`SessionModeState`: `currentModeId`, `availableModes`; `session/set_mode`) | `modelProfiles` |
| Available commands | `/effort`, `/subagents`, `/capabilities` |
| Model selection (`session/set_model`) | Profile provider/model |
| `session/request_permission` | Guardian non-allow, if D10 enables it |
| Client-side `fs/read_text_file` | See risk note below |
| Agent-owned terminal updates | Host-owned shell execution projected to clients; see resolved O1 |

Therefore the profile type is chosen to match structurally:

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

`SessionPolicy` carries `profiles: readonly Profile[]` and `currentProfileId: string`, which is
`SessionModeState` almost exactly. The ACP adapter becomes a projection rather than a
translation layer.

**[Verified]** `DEFAULT_MODEL_PROFILES` (`sol-low`, `sol-medium`, `sol-high` — see
`SETTINGS.md`) maps onto this with no loss. Cycling *order* becomes array order that a client
may or may not use.

Consequence: Shift+Tab cycling stops being pi-tai's concern, which removes the behavior of
writing into the user's `~/.pi/agent/keybindings.json` — invasive enough today that it required
its own `SETTINGS.md` paragraph explaining how it preserves unrelated bindings.

**Risk note [Unverified]:** under ACP the *client* may serve `fs/read_text_file`, including
unsaved editor buffers. Guardian's canonical-path boundary (`guardian/paths.ts`) assumes the
filesystem is ground truth. This interaction must be analyzed before the ACP file surface is
enabled.

### D8 — Project trust moves to the Host, digest-bound and per-field **[Decided]**

`ctx.isProjectTrusted()` is Pi's. With no Pi, the Host needs its own trust store keyed on
canonical repository path. Two things change rather than port as-is:

**Trust the content, not just the path.** Today, trusting a project once trusts every future
edit of `.pi/pi-tai.json` and `.pi/agents/*.md`. Record the layer digest (already required by
D5) and re-prompt when it changes. This matters far more under an editor client than a CLI:
Zed opens arbitrary repositories routinely, and the CLI's "you `cd`'d here deliberately"
assumption does not survive that.

**Project agent definitions may only narrow.** **[Verified]** `README.md` states that trusted
nearest-project `.pi/agents` definitions have *highest* precedence, above user and packaged;
`packages/pi-tai/agents/thinker.md:8-30` shows that agent front matter carries an explicit
`tools:` list. A cloned repository can therefore redefine `worker` with a wider tool set.
Guardian reviews `bash` and `web_fetch` but not the composition, and not `write`/`edit`.

The resolver must enforce that a project-layer agent definition may only be a subset of the
same-named user or packaged definition's tools — never a superset — and may never set
`root: true`.

### D9 — Schema and resolution in Rust **[Decided]**

The Host is Rust; configuration logic is currently TypeScript. Three options were considered:

| Option | Verdict |
|---|---|
| (a) Worker resolves, Host stores | **Rejected.** The worker remains authoritative; this is the status quo with extra steps. |
| (b) Host passes raw layers to the worker; worker returns a resolved doc; Host pins it | **Rejected.** The Host commits a document it cannot independently validate, and every policy question requires a live worker. |
| (c) Schema and resolution in Rust, TypeScript types generated | **Chosen.** |

Rationale for (c): the codegen pipeline already exists and is enforced.
**[Verified]** `crates/runtime-protocol/src/bin/export-bindings.rs` uses specta, is wired to
`npm run protocol:generate` / `protocol:check`, and `protocol:check` is the first step of
`npm run check`, which `just check` runs. Configuration is precisely the kind of thing the Host
should own end to end. The cost is reimplementing a shallow merge —
**[Verified]** `loadPiTaiConfig` is a spread over four layers, not a complex algorithm.

Properties of the current loader to preserve in the port:

- pure (no side effects beyond reading the supplied layers);
- warnings, not throws, for invalid values;
- frozen defaults;
- invalid values ignored rather than fatal.

Target signature, taking contents rather than paths so it is testable without a filesystem:

```rust
fn resolve(layers: &[ConfigLayer], trust: &ProjectTrust) -> (SessionPolicy, Vec<Warning>)
```

### D10 — Guardian's stance becomes explicit configuration **[Decided]**

**[Verified]** There is **no** interactive approval path in the code. A grep across
`packages/pi-tai/src/guardian/` for approval, permission, confirmation, and `hasUI` returns only
a message string at `guardian/register.ts:158` instructing the agent to continue without asking.

Therefore: `README.md` is correct ("Guardian never asks for approval"); the `SETTINGS.md`
paragraph stating "Interactive approval after a denied or failed review applies once to the exact
current invocation; noninteractive modes fail closed" **describes behavior that does not exist**
and must be corrected regardless of this plan.

This matters because never-asking is currently as much a constraint as a principle — there is no
good way to interrupt a TUI turn for approval. ACP supplies `session/request_permission` with
real editor UI, so the constraint lifts and the principle must stand on its own.

Decision: **keep never-ask as the default.** The fail-as-tool-result behavior is genuinely better
for autonomy and is the most distinctive property of the system. But make it explicit:

| Field | Plane | Default | Note |
|---|---|---|---|
| `guardian.onNonAllow` | HostMachineConfig, privileged | `"fail"` | `"ask"` permitted only when the client advertises the permission capability |
| `guardian.reviewerModel` | HostMachineConfig, privileged | pinned | Currently hardcoded |
| `guardian.timeoutMs` | HostMachineConfig, privileged | `30_000` | Currently hardcoded |

**[Verified]** `resolveReviewerModel` (`guardian/reviewer.ts:47-59`) falls back
`codex-auto-review` → `gpt-5.4-mini` → `gpt-5.4`. This silently changes the security reviewer
between machines. It must become pinned configuration that fails loudly rather than a silent
fallback chain.

---

## 4. What the cutover deletes or relocates

The cutover deletes **Pi harness responsibilities**, not necessarily the Pi client. A feasibility
spike must first prove that Pi can operate as an ACP client with the Host as the sole authority.

| Module | Disposition |
|---|---|
| `packages/pi-tai/src/response-editor/` | Reassess for the Pi client; delete if ACP/client editing makes it redundant |
| `packages/pi-tai/src/footer/` | Retain only as Pi client chrome |
| `packages/pi-tai/src/ansi-theme/` | Retain as Pi client-local preferences and presentation |
| `packages/pi-tai/src/keybindings/` | Retain client-local bindings only; stop mutating Host or policy configuration |
| `packages/pi-tai/src/notifications/` | Retain as a Pi client projection of ACP updates |
| `packages/pi-tai/themes/` | Retain while the Pi ACP client is supported |

The following still leave the runtime path:

- `pi.on("session_start")` configuration reload (`config/register.ts:29`), superseded by D4;
- Pi-owned configuration, credentials, model-catalog, trust, session, and execution authority;
- the current `PiTaiRegistrars` / `createPiTaiExtension` harness composition shell. It may be
  replaced by a thin ACP client bootstrap rather than deleted outright.

`concurrency`, `jj`, `guardian`, `web`, `capabilities`, `subagents`, `session-title`,
`compaction`, and `work-context` become `@pi-tai/core`. Pi-specific chrome, preferences, and ACP
projection belong to a separate client adapter and must not leak Pi dependencies back into core.

---

## 5. Sequencing

### 5.1 Ordered steps

| # | Checkpoint | Risk | Depends on | Acceptance boundary |
|---|---|---|---|---|
| 1 | Align the roadmap and initiative scopes with this plan | None | — | I01–I04 and I10 consistently describe ACP, the Pi client feasibility gate, and Host policy authority |
| 2 | Replace the implicit optional-config runtime discriminator (P3) | Low | — | Runtime mode is explicit and tests cover both `pi-cli` and `host-worker` wiring |
| 3 | Split `SessionPolicy`, `HostMachineConfig`, and client-local preference types while preserving the current loader | Low | 1 | Existing behavior is unchanged; Pi themes and notifications are client-only |
| 4 | Add provenance, digests, scope, and privileged tags; reject privileged project values | Low | 3 | Every resolved policy field is explainable and project privilege tests fail closed |
| 5 | Implement the pure Rust resolver and generated TypeScript bindings | Medium | 4 | Fixture/differential tests agree with preserved loader behavior; invalid values warn rather than abort |
| 6 | Extend runtime/session protocols to carry resolved policy and provenance | Medium | 5, I03 protocol foundation | Worker accepts pinned policy while any temporary legacy path is explicit and test-only/migration-scoped |
| 7 | **Cut configuration authority over to the Host** | High | 6 | Host resolves and pins policy; worker opens no config files; replay and mid-session-edit tests prove one authority |
| 8 | Add revision-guarded `session.set_policy`; make profile and effort changes commands | Medium | 7 | Commands/events replay deterministically and reject stale revisions |
| 9 | Wire ACP modes, models, commands, permissions, and Host-owned terminal projection | Medium | 8 | Zed/T3-facing ACP baseline is negotiated and clients receive display-only terminal updates |
| 10 | Prove the Pi interactive-session backend seam and scaffold `pi-tai-client` | Medium | 9 | The new executable runs without a local `AgentSession`; attach/resume, cursor replay, streaming, prompt, cancellation, and terminal projection work over ACP |
| 11 | Productize `pi-tai-client` while retaining legacy `pi-tai` | Medium | 10 | Themes, editor, footer, keybindings, renderers, and notifications work client-locally; cross-client handoff is tested; legacy direct mode is a separate explicit executable/package with no silent fallback |
| 12 | Make Guardian machine configuration explicit (D10) in a separate change | Security-sensitive | 7; separate from 7 | Reviewer model is pinned, timeout is configured, and non-allow behavior remains fail-by-default |

### 5.2 The critical step

**Checkpoint 7 is the step that ends dual authority.** Checkpoints 3–6 prepare and prove that
cutover without changing the authority owner early. Checkpoints 1–3 can start immediately;
checkpoint 2 is independent of the documentation alignment and policy type split.

### 5.3 Binding constraint

Roadmap migration rule 4 states: "Do not combine broad repository moves with security-sensitive
behavior changes." **Checkpoint 7 must not be combined with checkpoint 12 / D10.** Moving
configuration authority and changing security-policy defaults in one change is exactly the
prohibited combination. Land D10 separately, after the authority cutover unless new evidence
requires otherwise.

### 5.4 Relationship to existing initiatives

| Initiative | Effect of this plan |
|---|---|
| I01 (Shared core) | **Scope changes.** Core extraction follows removal of Pi harness responsibilities; retained Pi client code becomes an adapter, not core. |
| I02 (Host session authority) | **Extended.** Session policy joins session state as Host-owned. |
| I03 (Host/runtime convergence) | **Extended and blocking.** Checkpoints 6–7 depend on its protocol and supervision foundation. |
| I04 (Local client contract) | **Scope changes.** ACP is the common client boundary; add a Pi ACP-client feasibility gate and dedicated-CLI fallback. |
| I10 (Desktop and ACP) | **Promoted.** ACP becomes the common client protocol for Zed, T3 Code, and any CLI client. |
| I11, I12 | Unaffected. |

The roadmap index and affected initiatives must remain aligned with these checkpoints. Temporary
compatibility code belongs to checkpoints 6–7 and is deleted no later than checkpoint 11.

---

## 6. Repository health — parallel track

This work is independent of the cutover and can proceed concurrently. It came out of a full
design review of the repository on 2026-07-25.

### P1 — Add a formatter and linter, then reformat `concurrency/` and `jj/` **[Highest leverage]**

**[Verified]** There is no formatter or linter configured: no biome, eslint, prettier, oxlint,
dprint, or editorconfig, and no `[lints]` section in `Cargo.toml`. Nothing pushes back on
density.

Measured density:

| Module | Lines | Lines > 120 chars |
|---|---|---|
| `jj` | 2,990 | 425 (14%) |
| `concurrency` | 3,289 | 247 (7%) |
| `subagents` | 4,411 | 208 (4%) |
| `guardian` | 1,218 | 18 (1%) |
| `config`, `web`, `footer`, `capabilities` | ~1,600 | 8 (0.5%) |

**[Verified]** Extremes: `concurrency/persistence.ts:226` is 702 characters;
`concurrency/reviews.ts:24` is 582; `concurrency/host-state.ts:70` is 622. Whole interfaces are
declared as single lines of 15 readonly fields. There are **13 comment lines in 15,401 lines**
of `packages/pi-tai/src`.

This is not cosmetic: density tracks with recency and complexity, which is the inverse of what
is wanted. The invariants encoded in `concurrency/` and `jj/` are the ones that cannot afford to
be wrong, and they are currently the least reviewable code in the repository. The Rust half is
idiomatic and readable by comparison, so the inconsistency is within the TypeScript only.

### P2 — Add CI running `just check`

**[Verified]** There is no `.github/` directory. `npm run check` already chains
`protocol:check → typecheck → test → test:rust`. For a project whose premise is
agent-generated changes gated by deterministic checks, having the gate and not running it
automatically is a conspicuous hole.

### P3 — Replace the implicit runtime-mode discriminator

**[Verified]** Four sites in `packages/pi-tai/src/subagents/register.ts` branch production
behavior on the presence of an unrelated optional dependency:

- `:113` — `dependencies.config ? new MemoryDelegationStore() : new FileDelegationStore(storeRoot)`
- `:116` — selects between a throwing launcher stub and `PiChildProcessLauncher`
- `:132` — gates `HostLegacyContextMigrator`
- `:297` — forwards config

`config` is a configuration service. Using its presence to mean "we are in the in-process
production runtime" is an invisible coupling that neither the type system nor the documentation
explains. Anyone wiring `config` for an unrelated reason silently switches persistence and
launch strategy.

Replace with an explicit `runtime: "pi-cli" | "host-worker"` field. One-hour fix; removes a
landmine that will otherwise be tripped during steps 3–6.

### P4 — Split `subagents/register.ts`

**[Verified]** The file is now approximately 2,190 lines after the rebased commits (2,016
before). It mixes dependency wiring, tool schema definitions, Host projection publishing, and a
TUI widget. `:166` is a single filter expression spanning three nested ternaries over workspace
phases.

**This is the file that must be dismantled when the Pi extension shell goes away**, so every
tool added to it is deferred cost. **[Recommended]** split along the seams already present:
wiring, tool declarations, host projection, UI. See also the tools-as-data recommendation in
Part 7.4.

### P5 — Decouple persistence from the wire contract

**[Verified]** `docs/architecture/REPOSITORY.md` lists "protocol DTOs becoming persistence
entities" as a forbidden dependency direction. `crates/event-store/src/lib.rs:3` imports
`pi_tai_host_protocol::HostEvent` and `:356` reconstructs it directly from SQLite rows. The wire
contract and the storage schema are now the same type and cannot be versioned independently —
which is precisely what the rule exists to prevent.

Either introduce a distinct persisted event type, or amend `REPOSITORY.md` to record the
coupling as intentional. Either is acceptable; the current state, where the document forbids
what the code does, is not.

### P6 — Untrack generated UI output

**[Verified]** `apps/host/dist/assets/index-D7N2fIl0.js`, `index-BzDKPuJt.css`, and `index.html`
are tracked. `REPOSITORY.md` states generated UI bundles are "built for releases, not tracked
unless a packaging constraint is documented," and no such constraint is documented.
`apps/host/src-tauri/tauri.conf.json:7` has a `beforeBuildCommand` that regenerates them anyway.
Root `.gitignore` has `/dist/` (root-anchored), which is why they slipped through.

Note the correct counter-example: `packages/runtime-protocol/src/generated.ts` is tracked *and*
has a `protocol:check` mode enforcing its source of truth, satisfying the "explicit source of
truth and check mode" rule.

### P7 — Decide the `broker` crate's fate

**[Verified]** `REPOSITORY.md` says to "retain only if distinct from session service." It is 519
lines, consumed by `host-kernel` and `host-server`, and the event store's tables are named
`broker_sessions`. The decision is due.

### P8 — Correct stale documentation

- **[Verified]** `SETTINGS.md` Action Guardian section describes an interactive approval path
  that does not exist in code. See D10.
- **[Verified]** `TODO.md` item "After merging a planner workspace, the thinker should check
  commit history and remove empty inner commits, plus name any unnamed commits" is already
  described as implemented in `README.md`'s `integrate_workspace` paragraph.
- Once D6 lands, `SETTINGS.md` must be restructured along the three-plane split, and its
  "Native Pi settings" section removed.

### P9 — Test hygiene

**[Verified]** The unit suite writes enrollment state into `~/.config/jj/repos/`; that directory
held 170 entries modified the same day. Tests should confine this to a temporary root and clean
up. Symptom observed: the suite fails under a sandbox that blocks writes outside the project
(4 failures in `subagents.test.ts` and `session-workspace.test.ts`), and passes fully outside
it.

---

## 7. Rebased commits — state and follow-ups

### 7.1 What was done

Four commits from the `orchestration-impl` workspace were rebased onto the current line on
2026-07-25. Resulting order:

```
llywskwr  (working copy — uncommitted stale-update work)
qmomyzwv  feat(jj): reconstruct managed workspace attachments
tvkxmluk  feat(subagents): expose workspace review and recovery state
yvlpmppk  feat(concurrency): coordinate isolated workspace file claims
kywpnzoz  feat(jj): classify workspace recovery from observed state
owquunst  docs(todo): track notification prompt improvement
```

**[Verified]** No conflicts. Typecheck clean. 220 unit tests pass, 0 fail (run outside the
sandbox; see P9). Pre-rebase operation for rollback: `jj op restore d2f8e06440ae`.

### 7.2 Verdict: keep all four

They are entirely core-side — no `ctx.ui`, no terminal, no Pi presentation — and are `@pi-tai/core`
material as-is. They strengthen the case for extraction rather than complicating it.

| Change | Content |
|---|---|
| `kywpnzoz` | `workspace-recovery.ts` (214 lines): `WorkspaceRecoverySnapshot` gathers expected-vs-observed evidence; `classifyWorkspaceRecovery` is a **pure reducer** returning one of 11 dispositions; `WorkspaceRecoveryPlanner` emits a digest-bound plan. Adds `workspace_custody_status` and `workspace_recovery_plan` tools. |
| `yvlpmppk` | `WorkspaceFileSetCoordinator` + `WorkspaceFileCheckpointer`: multiple children share one isolated workspace via per-file-set claims. Reuses `SharedFileSetCoordinator` through an adapter projecting an isolated workspace record into `PersistedSharedSourceV1` — one queue implementation, two backings. The checkpointer hashes the *unowned* complement fileset before and after the squash and fails if it changed. |
| `tvkxmluk` | `reconcile_workspace` tool plus `RECOVERY.md` / `JJ.md` / `STATE-MACHINES.md` / `TOOLS.md` updates. |
| `qmomyzwv` | Small follow-up wiring `reconcileAllocation` into the reconstruct path. |

### 7.3 Patterns worth generalizing

**Snapshot-bound plans with digest revalidation.** `reconcile_workspace` re-inspects, re-plans,
and refuses if the plan digest has changed:

```ts
if (plan.planId !== params.planId) throw new Error("Recovery plan is stale; inspect and plan the workspace again.");
```

Since `planId` is a digest of the snapshot, this is a compare-and-swap on evidence — the model
cannot act on a stale view. **This should be the template for every state-mutating tool.** It
maps directly onto D4: `session.set_policy` wants the same guarantee, and
`HostCommand.expectedRevision` (`packages/host-protocol/src/index.ts`) already exists to carry it.

**Pure classification.** `classifyWorkspaceRecovery` is a pure function from a snapshot to one
disposition — no filesystem, no jj, no model. It is the same shape recommended for configuration
resolution in D9, and would port to Rust cleanly if recovery classification ever moves into the
Host.

### 7.4 Required follow-ups

| # | Severity | Item |
|---|---|---|
| F1 | **High** | **Swallowed inspection failures invert fail-closed.** In `workspace-recovery.ts` `inspect`, `range(...).catch(() => [])` and `foreignDescendants(...).catch(() => [])` mean a failed query returns "no foreign descendants." But `foreignDescendantIds.length` is the *first* check in the classifier and routes to `attention_required`, so a swallowed error turns a possible ownership breach into `consistent`. Push a `custody_uninspectable` discrepancy instead — that kind already exists and already classifies to `attention_required`. **Fix before building further on recovery.** |
| F2 | Medium | **Unreachable dispositions.** `review_stale` and `breached` are in the union, in `actionsFor`, and in the docs, but `classifyWorkspaceRecovery` never returns either. `review_stale` matters most: the snapshot carries no review fields, yet `RECOVERY.md:84` (added by `tvkxmluk`) claims the snapshot covers "review." The docs commit overstates what the code commit delivers. Either wire them or mark them reserved. |
| F3 | Low | **`as any` in the evidence path.** `workspace-recovery.ts` `inspect` casts `identity.rootChangeId as any` and `identity.expectedHeadChangeId as any` (two sites). Branded-type escape hatches in the one file whose job is trustworthy evidence. The `changeId()` brand constructor is already imported and used correctly elsewhere. |
| F4 | Low | **Density.** `workspace-file-checkpoint.ts` packs roughly 200 lines of logic into 69; `checkpoint` is one ~30-statement function. Subsumed by P1 once a formatter exists. |

### 7.5 Fit notes for the cutover

- These commits deepen `register.ts`'s role as a Pi-shaped composition root
  (`pi.registerTool`, `ExtensionContext`). The `reconcile_workspace` handler is a 15-branch
  if/else dispatching on `action.kind` inline in a tool registration — domain logic living next
  to Pi registration rather than next to the planner it belongs to.
- **[Recommended]** Declare tools as data — a `tools/` module exporting
  `{ name, schema, handler }` — with `pi.registerTool` as one thin adapter over it. The ACP and
  Host surfaces then reuse the same declarations instead of reimplementing them, and checkpoint
  11 becomes adapter isolation rather than a rewrite.
- `WorkspaceRecoveryAction.automatic: false` is an ACP affordance waiting to happen: a
  non-automatic action is what `session/request_permission` or an attention state in the client
  should render. Shape the type with that in mind now rather than retrofitting.

### 7.6 Former workspace follow-ups

**[Decided]** The `orchestration-recovery`, `harness-issue-tool`, and related temporary
workspaces/branches were removed. No recovery or preservation work is required. Any still-useful
ideas will be reconsidered from the current repository state rather than recovered from those
workspaces.

---

## 8. Resolved inputs and remaining open questions

| # | Status | Decision or question |
|---|---|---|
| **O1** | **Resolved** | Shell execution is Host-owned and passes through Guardian before side effects. The actual process may run in a Host-supervised worker/adapter, but clients only receive ACP terminal projections. Approved commands continue across client disconnects unless explicitly cancelled. Interactive/PTY commands are out of scope. Clients may display terminal output but receive no stdin takeover or execution authority. |
| **O2** | **Resolved** | The temporary orchestration/recovery workspaces and branches are gone. No preservation work is required. |
| **O3** | **Resolved** | T3 Code uses ACP. Integration details may be decided later; ACP is the common client boundary. |
| **O4** | **Resolved** | Use XDG Base Directory locations and keep data classes separate. Settings belong under `$XDG_CONFIG_HOME/pi-tai`; credentials under `$XDG_DATA_HOME/pi-tai/credentials`; other persistent application data under separate paths in `$XDG_DATA_HOME/pi-tai`; durable sessions and logs under distinct paths in `$XDG_STATE_HOME/pi-tai`; disposable caches under `$XDG_CACHE_HOME/pi-tai`; ephemeral sockets/locks under `$XDG_RUNTIME_DIR/pi-tai` when available. Do not place durable sessions or credentials in cache, and do not collapse these roots into one application directory. |
| **O5** | **Resolved — implementation proof remains** | Build a separate `pi-tai-client` executable using a Pi interactive-session backend seam and ACP. Retain the current `pi-tai` direct extension during migration. Do not use stock-extension input interception if it leaves a hidden local agent session; fall back to the smallest maintainable Pi variant or Pi TUI-based executable if the seam cannot be upstreamed cleanly. |

---

## 9. Appendix — verified facts

Collected so a planner need not re-derive them. All verified 2026-07-25 against the repository
at `llywskwr` (post-rebase).

**Build and test**

- `npm run typecheck` — clean.
- `npm run test:unit` — 220 tests, 220 pass, ~10s, outside sandbox.
- `npm run check` = `protocol:check && typecheck && test && test:rust`.
- No CI configuration exists.
- No linter or formatter configuration exists.

**Sizes**

- `packages/pi-tai/src`: ~15,400 lines, 13 comment lines.
- Total tracked TS/TSX: ~27,300 lines. Rust: ~6,500 lines.
- `subagents/register.ts`: ~2,190 lines (largest file).
- 970 lines exceed 120 characters across `packages/` and `services/`.

**Key file references**

| Fact | Location |
|---|---|
| Config resolution (four-layer spread) | `packages/pi-tai/src/config/load.ts:39` |
| Config reload on session start | `packages/pi-tai/src/config/register.ts:29` |
| Project trust gate | `packages/pi-tai/src/config/load.ts:43` |
| Config file paths | `packages/pi-tai/src/config/paths.ts:6` |
| Worker reads config off disk | `services/pi-runtime/src/pi-runtime.ts:292` |
| Worker reads `auth.json` | `services/pi-runtime/src/pi-runtime.ts:245` |
| Guardian reviewer model + timeout constants | `packages/pi-tai/src/guardian/reviewer.ts:18-19` |
| Guardian reviewer fallback chain | `packages/pi-tai/src/guardian/reviewer.ts:47-59` |
| Guardian "continue without asking" message | `packages/pi-tai/src/guardian/register.ts:158` |
| Runtime-mode discriminator | `packages/pi-tai/src/subagents/register.ts:113,116,132,297` |
| ACP session surface unwired | `bins/acp/src/app.ts:23` |
| Event store imports wire DTO | `crates/event-store/src/lib.rs:3,356` |
| Specta codegen entry point | `crates/runtime-protocol/src/bin/export-bindings.rs` |
| `expectedRevision` on commands | `packages/host-protocol/src/index.ts` |
| Agent front-matter tool lists | `packages/pi-tai/agents/thinker.md:8-30` |
| Tauri frontend build command | `apps/host/src-tauri/tauri.conf.json:7` |

**Dual-authority store pairs (all resolved at runtime by optional-dependency presence)**

`FileReviewStore` / `HostReviewStore`, `FileRepositoryEnrollmentStore` /
`HostRepositoryEnrollmentStore`, `FileChildContextStore` / `HostChildContextStore`,
`FileDelegationStore` / `MemoryDelegationStore`.
