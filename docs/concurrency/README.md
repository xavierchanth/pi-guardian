# Agent concurrency

## Purpose

The concurrency subsystem coordinates collaborative design, approved execution, private child contexts, isolated JJ workspaces, parent/child messages, independent review, integration, recovery, and recursive accounting.

Its output is one of:

- an approved design or roadmap decision;
- reviewed, integrated, and verified repository changes;
- a proved no-change result;
- a bounded user decision request;
- an `attention_required` handoff with preserved evidence.

It does not own publication, remote bookmarks, user JJ configuration, destructive recovery, or Host/client session arbitration.

## Workflow

```mermaid
flowchart TD
  Request[User request] --> Ground[Orchestrator grounds request]
  Ground --> Evidence[Direct inspection · Scout · Researcher]
  Evidence --> Design[Orchestrator and user iterate on design]
  Design --> Decision{User approves current plan?}
  Decision -->|revise| Design
  Decision -->|yes| Approval[Immutable approved-plan receipt]
  Approval --> Route{Approved work type}
  Route -->|product implementation| Lead[Implementation Lead workspace]
  Route -->|standalone docs or roadmap| Documenter[Documenter workspace]
  Lead --> Direct[Implement directly]
  Lead --> Workers[Coordinate bounded Workers]
  Direct --> Freeze[Validate and freeze exact range]
  Workers --> Freeze
  Documenter --> Freeze
  Freeze --> Review[Independent Reviewer in same workspace]
  Review -->|blocking findings| Repair[Original role repair cycle]
  Repair --> Review
  Review -->|approved| Integrate[Orchestrator integrates exact range]
  Integrate --> Verify[Verify product state and close custody]
```

The Orchestrator follows the codebase-grounded design workflow for implementation requests. It gathers evidence, presents material decisions and tradeoffs, asks the user to resolve consequential ambiguity, and revises the complete effective plan. Implementation cannot begin until explicit user approval is recorded against the current plan revision and digest.

## Roles

| Role | Owns | May delegate | Workspace authority |
|---|---|---|---|
| **Orchestrator** | User collaboration, grounded design, effective plan, approval boundary, routing, review disposition, integration, final verification | Implementation Lead, Documenter, Reviewer, Scout, Researcher | Exclusive main orchestration workspace; create, review, integrate, close child workspaces |
| **Implementation Lead** | One approved product task and its complete delivery | Worker, Scout, Researcher | Implement or coordinate within one dedicated workspace; never create or integrate workspaces |
| **Worker** | One bounded implementation assignment | Scout, Researcher | Assigned target and file set in the Implementation Lead workspace |
| **Documenter** | One approved standalone architecture, design, documentation, or roadmap update | None | Explicit Markdown documentation paths in one dedicated workspace |
| **Reviewer** | Independent verification against approved intent and exact frozen range | Scout, Researcher | Read-only in the implementation workspace |
| **Scout** | Repository evidence | None | Read-only view of caller workspace |
| **Researcher** | Current external and repository evidence | None | Read-only view of caller workspace |

The Orchestrator never launches a generic Worker. Small product work still goes to an Implementation Lead, which may implement directly. Documentation accompanying product code remains in that Implementation Lead workspace; Documenter is for standalone documentation changes.

## Task and approval authority

Every substantial request has one durable root task. Design plans are append-only revisions with one current effective revision. Explicit user approval creates an immutable receipt containing:

- current plan revision ID and content digest;
- approving user-message evidence;
- Orchestrator context and timestamp.

Implementation Lead and Documenter assignments require a receipt matching the current root plan. A later plan revision makes prior approval stale. Children receive a self-contained task packet and immutable task snapshot rather than parent conversation history.

## Workspace invariants

1. The main workspace is reserved for Orchestrator lifecycle operations and integration.
2. The Orchestrator cannot edit files or use shell mutation.
3. Every writable child starts in a dedicated managed JJ workspace.
4. Workers share their Implementation Lead's workspace under disjoint file-set ownership; nested workspaces are forbidden.
5. Documenters can modify only assigned documentation paths.
6. Every nonempty delegated range receives independent review in that same workspace before integration.
7. Repair resumes through the original workspace role, followed by focused re-review.
8. Integration, verification, and closure remain Orchestrator-only deterministic operations.

## Parent/child communication

- Children push typed questions, terminal results, status responses, and incidents.
- Parents receive bounded reports, never transcripts or raw tool streams.
- `await_child_event` is an optional token-free barrier, not polling.
- Every terminal report is delivered and acknowledged exactly once.
- Delegation is not completion: a parent cannot settle with unresolved or unacknowledged direct children.

See [Runtime](RUNTIME.md).

## Completion

| Actor/artifact | Complete means |
|---|---|
| Scout/researcher | Terminal evidence report acknowledged |
| Worker | Assigned paths checkpointed, validation reported, terminal event acknowledged |
| Implementation Lead | Descendants acknowledged, complete approved task validated, history curated and frozen; still review-pending |
| Documenter | Assigned documentation validated and frozen; still review-pending |
| Reviewer | Structured findings delivered and acknowledged |
| Delegated workspace | Reviewed, integrated, verified, and custody closed or proved no-change |
| Orchestrator | User-approved intent delivered; every child acknowledged and every workspace closed or honestly mutation-stopped |

## Normative documents

- [Runtime](RUNTIME.md)
- [JJ coordination](JJ.md)
- [State machines](STATE-MACHINES.md)
- [Agents and tools](TOOLS.md)
- [Failure and recovery](RECOVERY.md)
- [Testing](TESTING.md)
