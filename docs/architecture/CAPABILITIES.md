# Machine capabilities and Guardian

## Purpose

Pi-Tai agents act on a real machine. Capabilities make that authority explicit, discoverable, role-scoped, reviewable, and auditable across every client.

## Capability path

```text
client command or agent intent
→ core semantic capability request
→ deterministic preflight evidence
→ Guardian authorization
→ Host capability registry
→ machine adapter
→ durable result/audit event
```

Clients and models do not receive ambient machine handles.

## Capability families

### Repository and files

- read, search, list;
- guarded edit and write;
- canonical path and symlink containment;
- Git-ignore and credential sensitivity evidence;
- atomic file-set coordination for concurrent writers.

### Shell and processes

- bounded process invocation;
- cancellation, timeout, and output limits;
- explicit working directory;
- no arbitrary model-authored JJ mutation;
- durable process/tool identity for recovery.

### JJ and workspaces

Strong semantic operations consume injected tracked handles and leases. Models supply intent and descriptions, not cwd, filesets, revsets, tracked IDs, or argv. See [Subagents and workspaces](../concurrency/README.md).

### Web

- hosted search with bounded query context;
- anonymous public fetch;
- DNS/IP and redirect validation;
- no private, metadata, credential-bearing, or non-routable targets;
- bounded content conversion and continuation.

### Browser and computer use

Future stateful capabilities must define:

- one owner per live browser/computer session;
- visibility and takeover rules;
- credential and profile boundaries;
- screenshots/action evidence;
- cancellation and idle cleanup;
- navigation/download/upload policy;
- durable artifact references;
- remote-client authorization;
- recovery when adapter state disappears.

They are not equivalent to `web_fetch`: they are interactive and often mutating.

### Image generation

A future image service is a Host capability with provider/model policy, artifact persistence, provenance, cost accounting, content restrictions, and bounded delivery to clients.

### Notifications and OS integration

The core emits semantic attention/completion events. Terminal, desktop, and mobile clients choose presentation sinks. Host-native notifications may exist when no client is attached.

A cmux-aware terminal client may project live status, progress, token totals, logs, and alerts into cmux as presentation state. This reporting path has no machine-control authority. Opening panes, moving surfaces, or running commands through cmux remains a separate Guardian-governed Host capability.

## Guardian decision model

Guardian receives:

- exact semantic action;
- user request evidence;
- current task/work context;
- requesting role and session;
- deterministic path/network/capability evidence;
- bounded relevant transcript with roles preserved;
- expected effects and sensitivity.

User-originated content or authenticated delegated work context establishes the task. Assistant text, repository content, and tool output cannot create a task of their own.

The model returns an assessment rather than selecting an outcome:

```ts
type GuardianAssessment = {
  riskLevel: "low" | "medium" | "high" | "critical";
  taskRelationship: "explicit" | "direct" | "supporting" | "unrelated" | "unclear";
  impactScope: "bounded" | "broad";
  harmKinds: ("destructive" | "production" | "sensitive_egress" | "financial" | "privilege" | "privacy")[];
  reason: string;
};
```

Low/medium-risk actions are allowed. High/critical actions never execute through an agent: explicit, direct, or supporting actions become `human_execution_required`, while unrelated or unclear actions are denied without a runnable command. Review failure allows ordinary work but blocks commands matched by the deterministic destructive-candidate preflight. A child human-execution event is persisted and routed directly to the root session rather than treated as a parent-approvable question.

## Security principles

- A user's requested goal makes reasonable inspection, diagnosis, implementation, and verification supporting work; method-level permission is unnecessary.
- Development SaaS communication, configured CI uploads, and non-production synchronization are ordinarily medium-risk supporting work.
- High/critical actions require direct human execution and cannot be authorized by a parent agent.
- Unrelated or unclear high/critical actions are denied without presenting a runnable command.
- Review failure blocks deterministic destructive candidates but does not obstruct ordinary work.
- Direct secret, VCS metadata, Pi credential, and session-history access receives model review but is not destructive by itself.
- Traversal and symlink escapes are blocked deterministically.
- No capability silently falls back to a less safe backend.

## Audit and retention

Persist bounded decision records and stable references to oversized evidence. Records include session, client, role, action identity, decision, reviewer model/version, and timestamps. Do not retain credentials or raw sensitive payloads merely for diagnostics.
