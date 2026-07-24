# Failure, blocking, and recovery

## Dispositions

| Disposition | Meaning |
|---|---|
| **Continue** | Expected state; required identity and ownership remain valid |
| **Refresh** | Re-read and recompute derived evidence |
| **Wait** | Queue behind known owner/event without failing |
| **Reroute** | Preserve work and choose a different execution lane |
| **Repair** | Enter bounded owned correction followed by review |
| **Warn/defer** | Preserve a nonblocking concern for the user |
| **Ask** | Several safe semantic choices or extra authority are required |
| **Stop mutation** | Continuing may corrupt, lose, misattribute, or publish work |

Stopping one affected mutation does not automatically terminate unrelated children or the root session.

## Condition matrix

| Condition | Disposition |
|---|---|
| Child completes while parent works | Continue; push bounded event |
| Parent has no independent work | Wait with token-free await |
| User speaks during await | Resolve await; continue children |
| Root turn aborts | Continue children |
| Explicit child cancellation | Cancel selected cycle; preserve custody |
| Metadata status requested | Continue without model turn |
| Semantic status requested | Request bounded summary and resume child |
| Parent asks for transcript | Deny that access; request summary |
| Root/worker restarts | Refresh post-order; clear/reacquire locks |
| Child crashes and old writer is quiescent | Start linked recovery cycle |
| Old writer cannot be proved quiescent | Stop affected writes |
| Shared file set overlaps another | Wait FIFO or reroute |
| File changed before claim acquired | Refresh and re-read |
| File changed while claim held | Stop affected writes; ownership breach |
| Shared checkpoint extraction ambiguous | Reroute/ask; never guess |
| No WIP and source `@` empty | Ensure WIP deterministically |
| No WIP and source `@` nonempty | Ask/normalize; do not relabel silently |
| Missing private selector | Warn; do not edit config |
| WIP immutable | Stop WIP mutation |
| Commit IDs changed | Refresh/continue |
| Explicit clean workspace rebase | Continue after exact verification |
| Normalized patch changed | Re-review |
| Owned unique conflict | Repair |
| Foreign/ambiguous conflict | Ask or stop mutation |
| Tracked Change ID changed with receipt | Continue from receipt |
| Tracked Change ID changed without receipt | Stop automatic mutation; inspect |
| Divergent/non-unique Change ID | Stop mutation |
| Safe empty interior revisions | Normalize |
| Entire range empty | Close no-change |
| Known persisted operation phase survived crash | Resume next proved phase |
| Completed phases cannot be reconstructed | Stop mutation |
| Cleanup fails after verified semantic closure | Mark cleanup pending; retry exact cleanup |
| Goal-blocking review finding | One bounded repair cycle |
| Medium/low/out-of-scope finding | Warn/defer |
| Missing usage telemetry only | Continue with warning |

## Hard mutation stops

Only these classes inherently stop affected automatic mutation:

1. ambiguous/divergent identity;
2. unowned writes or foreign work in an owned range;
3. unknown partial mutation without reconstructable boundaries;
4. duplicate-writer risk;
5. missing authority for destructive disposal, publication, configuration, or semantic conflict choice;
6. critical review failure after the allowed repair budget.

## Interrupted operations

Restart does not blindly replay tool calls.

- Read-only inspection/status/await may reissue.
- File edit requires a new claim and fresh read.
- Checkpoint, workspace checkpoint, rebase, squash, and integration reconcile operation ID, graph, Change IDs, and receipts first.
- If postconditions already hold, synthesize the missing durable result.
- If no mutation boundary occurred, reissue safely.
- If boundaries cannot be proved, preserve evidence and stop.

Live locks never persist across process restart. Durable state retains intent and receipts, then resumed writers reacquire.

## Explicit user-directed recovery

### Rebind tracked change

May adopt one unique verified replacement Change ID only after explicit user authorization. Receipt records old/new identity and authorizing event. Divergent, disconnected, or foreign replacements remain unavailable.

### Resume operation

Continues only the next idempotent phase of one interrupted operation. It cannot skip, repeat an unproved phase, or guess rollback.

### Retry cleanup

Retries an exact recorded filesystem/runtime cleanup. It cannot alter history or discard nonempty work.

## Review loop budget

- `p0`/`p1`: repair when owned and within budget; approval is impossible while either remains.
- `p2`: thinker must repair or durably defer with rationale.
- `p3`: surface and optionally defer.
- `p4`: record as information.
- out-of-scope existing findings do not trigger automatic repair unless they pose immediate safety risk.

One implementation repair plus one focused re-review is automatic per workspace. Further cycles require user direction.

## Cleanup

Semantic closure and artifact cleanup are distinct. A cleanup failure cannot hide a semantic failure, and a semantically complete integration need not be misreported as failed solely because an exact managed directory remains. Cleanup validates canonical containment and symlinks and retains incidents/workspace evidence until custody is resolved.
