# Subagents and workspaces

Pi-Tai can hand a self-contained task to a background agent that works in its own
checkout, then fold the result back in. This document describes how that works and
why it is shaped the way it is.

## Durable lifecycle foundation

The first durability foundation is landed: subagents have opaque UUID authority IDs
while the nine public tools continue to use session-local `sa-N` labels. Versioned
lifecycle facts are folded from Pi's active branch (`getBranch()`), re-folded on
session start and tree navigation, and spawning fails closed when the host cannot
append an intent/running fact. Pi child journals use the durable ID as context and
their private session-file handle is captured, but children are **not** automatically
resumed. In-memory pruning no longer consumes pending delivery state.

Later phases remain pending: workspace-registry durable custody/root partitioning,
report artifacts and delivery ledger/channel separation, explicit continuation and
recreation, archive UI, and retention. Pi custom entries are an adapter behind the
`SubagentLifecycleStore` port, not a claim that Pi files are final Host authority.

Two modules do the work, and they know almost nothing about each other:

- **`packages/pi-tai/src/core/isolation/`** manages JJ workspaces. It has no concept of an agent — a
  workspace is a directory plus a range of changes, and its owner is an opaque label.
- **`packages/pi-tai/src/core/subagents/`** coherently owns subagent tools, backends, catalogs,
  lifecycle, and dashboard. Its manager has no concept of version control — a
  subagent gets a working directory, and where that directory came from is not its
  problem.

`packages/pi-tai/src/core/subagents/isolated.ts` is the only place they meet. Keeping them apart means a
failure in version control is diagnosable without reasoning about process spawning,
and vice versa.

## Workspaces

### Where a workspace branches from

**A managed workspace's root has the same parents as the source working copy `@`.**

This gives an agent everything you have already landed while never exposing your
in-flight `@` content. It holds whether `@` has one parent or several — when `@` is
an ordinary single-parent commit the rule is just "branch from `@-`", and when `@`
is a merge it branches from every parent. Parents are resolved to concrete change
ids at operation time and never stored as revsets, so a later `@` move cannot
silently retarget a pending operation.

A workspace's *content* is defined against that base — everything reachable from its
`@` but not from its base — rather than as a linear range from its own first commit.
That distinction matters for any workspace that has had other work merged into it,
whose commits are not descendants of its own root.

### Landing the work

`merge` picks between two strategies:

- **linear** — `jj rebase --revisions <changes> --insert-before @`. Chosen only when
  your `@` is empty and single-parent, where it is unambiguously safe. History stays
  flat.
- **merge-under** — `jj rebase -r @ -d <existing parents> -d <each head>`. Your `@`
  keeps every parent it had and gains the agent's work. Afterwards, when this merge
  introduced a parent that is already reachable through another parent, the manager
  runs `jj simplify-parents` against exactly that working-copy change. It skips this
  cosmetic step if redundancy predated the merge or the change has descendants,
  verifies every agent head remains reachable, and restores the captured operation
  if simplification or verification fails. That rollback is skipped if another
  operation intervened, rather than risking the loss of unrelated work. Cosmetic
  cleanup never fails the merge.

`auto` tries linear when the preconditions hold, and if the insert produces
conflicts it restores the pre-merge operation and retries as a merge. That fallback
is deliberate: conflicts are tractable in a live working copy, where you resolve them
by editing, and painful inside a rewritten range. Merge-under also keeps the agent's
work reviewable as a discrete chain rather than flattening it into your history.

Note the plural in *each head*. A workspace that collected work from concurrent
subagents holds several independent chains, and every one of them has to become a
merge parent. Taking only the newest change silently orphans the rest.

### Reclaiming

Empty scaffolding never reaches your stack: every workspace's working-copy commit is
empty by construction, and `merge` excludes empties from the moved set and abandons
them afterwards.

Workspaces are reclaimed at three points. A spawn that fails after `workspace add`
cleans up before the error propagates. A subagent that settles without producing
anything has its workspace discarded by a settle hook — safe precisely because there
is nothing to lose, which is why that hook never merges. Anything left by a crashed
session is swept at startup: empty workspaces are reclaimed, workspaces holding real
work are reported for you to decide about, and workspaces belonging to a
still-running subagent are left alone.

## Subagents

### Harnesses

A backend is a harness that can run a child: `pi` (an in-process SDK session),
`claude` (the Claude Agent SDK), or `codex` (`codex app-server` over JSON-RPC). Each
translates its native protocol into one neutral `SubagentEvent` stream, and nothing
above the backend layer sees a provider-specific message type.

All three are offered. A harness whose SDK or binary is missing reports itself
unavailable with a reason when a spawn asks for it, which is a clearer failure than
being silently absent.

### Isolation

**Isolation says where a subagent works, not what it may do.** A subagent spawned
with `isolation: "workspace"` gets a private checkout, and what it does there stays
there until you merge or discard it. One spawned with `isolation: "shared"` works in
your working copy, where its edits land alongside yours. Both get the same tools:
`shared` is not a read-only mode, and there are no roles and no per-spawn tool lists.

Enforcing a permission split here would not carry across harnesses. Pi's tool names
are not Claude's, and Codex has no per-turn tool allowlist at all, so a restriction
expressed in one harness's vocabulary means something different in the next. What
does travel is the choice of location, because it is a property of the repository
rather than of a provider's API, and it is the choice that actually decides how the
work comes back: as a reviewable unit you fold in deliberately, or as edits already
in front of you. Whether a subagent should be writing at all is stated in its
charter, which every harness reads.

Subagents are leaves — one level deep, always. A pi child's tool set omits the
delegation tools, so it has no way to start one of its own.

### Results

Spawning is fire-and-forget. A subagent's result is delivered into the parent
conversation when the parent next goes idle, so the parent starts work and
keeps going instead of polling. `subagent_wait` exists for when you genuinely cannot
proceed without an answer. With several ids it returns when any one finishes, includes every
requested result ready at that moment, and identifies those still running; call it again with the
remaining ids to collect staggered completions. Returned results (and only those results) are
consumed so they are not also auto-delivered. Already-finished ids return immediately.

At most four subagents run at once. The reservation is taken synchronously before the
first await, so several tool calls in one assistant turn cannot all observe a free
slot and race past the cap.

## Tools

Nine, with the judgment about when to use them living in prompts rather than in tool
schemas:

| Tool | Purpose |
|---|---|
| `subagent_spawn` | Start a subagent. `continue` reuses a settled subagent's workspace. |
| `subagent_wait` | Block until any named subagent finishes and repeatedly collect ready results. Foreground user input releases the wait without cancelling or steering pending agents. |
| `subagent_check` | Peek at one without blocking or consuming its result. |
| `subagent_send` | Steer a genuinely streaming run, or explicitly continue a normally settled conversation when its harness has a durable handle. Sends are FIFO per child. |
| `subagent_cancel` | Stop subagents, keeping their workspaces. |
| `subagent_list` | List subagents and their status. |
| `workspace_merge` | Fold a subagent's changes into the working copy. |
| `workspace_discard` | Throw a subagent's workspace away. |
| `workspace_status` | List workspaces and what they hold. |

Delegation is currently text-only. Conversation images and attachment objects are not
inherited or forwarded. A spawn containing a Pi clipboard image path under a trusted OS
temporary root is rejected before workspace or backend launch; callers must provide a
textual description or save the image at a stable, user-authorized project path. This is
a transient-path guard, not a durable attachment store or path authorization mechanism.

An interrupted, cancelled, pruned, or shut-down entry is closed and is never
automatically continued. Workspace reuse is a separate explicit spawn concern. A
settled conversation continuation is exposed as running only after its lifecycle fact
is durable; failed persistence leaves it terminal.

## Models

Defaults resolve from three sources, narrowest first: what the caller wrote, what the
alias implies, what the harness defaults to. The global default is
`pi` / `gpt-5.6-sol` / `low`.

| Alias | Provider/model | Effort | Allowed harnesses | For |
|---|---|---|---|---|
| `sol` | `openai-codex/gpt-5.6-sol` | low | pi, codex | implementation, and the global default |
| `terra` | `openai-codex/gpt-5.6-terra` | low | pi, codex | balanced OpenAI model |
| `luna` | `openai-codex/gpt-5.6-luna` | low | pi, codex | fast OpenAI model |
| `glm` | `opencode-go/glm-5.2` | low | pi | GLM 5.2 through OpenCode Go |
| `kimi` | `opencode-go/kimi-k3` | low | pi | Kimi K3 through OpenCode Go |
| `opus` | `anthropic/claude-opus-5` | medium | claude | design, planning, review |
| `sonnet` | `anthropic/claude-sonnet-5` | medium | claude | general Claude Code work |
| `fable` | `anthropic/claude-fable-5` | medium | claude | only when asked for by name |

This is a compatibility table, not just a preference table. Claude aliases can run
only through the Claude Code backend; explicitly pairing `fable`, `opus`, or
`sonnet` with `pi` or `codex` is rejected. The OpenCode Go aliases run only inside
Pi, while `sol` may explicitly use Codex. Explicit `anthropic/*` and
`opencode-go/*` model IDs obey the same restrictions. `fable` is never a default:
it is stronger than `opus` and priced accordingly, so it is reached for only on
request.

The OpenCode Go aliases require OpenCode credentials configured in Pi under the
`opencode-go` provider (`OPENCODE_API_KEY` or `/login`). The versioned source of
truth for every alias, provider/model ID, default effort, compatible harness, and
purpose is [`src/core/subagents/models.json`](../../packages/pi-tai/src/core/subagents/models.json).
Pi-Tai validates that catalog when it loads and refuses malformed or incompatible
entries.

The session you talk to is a separate matter: it runs whatever model you launched pi
with. Designing on a strong model while implementing on a cheaper one needs no
special machinery — set `defaultBackend` and start pi on the model you want to argue
with.

## Testing

Workspace behaviour is tested against real `jj 0.43.0` in a scratch repository, not
against mocks: the failure modes worth catching are jj's, and a mock would encode the
same assumptions the code does. Harnesses are tested against scripted event streams —
for Codex, a fake `app-server` speaking the real protocol, whose method names come
from `codex app-server generate-json-schema` rather than from memory.

## Research capability

External or source-backed research is delegated with `subagent_spawn`, `capability: "researcher"`, and normally `isolation: "shared"`. The root and Pi children have no direct web tools. The researcher role is the sole research alias; it applies compatible model/backend defaults and returns evidence with source URLs.
