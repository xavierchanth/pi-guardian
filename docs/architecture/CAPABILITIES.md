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

Strong semantic operations consume injected tracked handles and leases. Models supply intent and descriptions, not cwd, filesets, revsets, tracked IDs, or argv. See [JJ coordination](../concurrency/JJ.md).

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

## Guardian decision model

Guardian receives:

- exact semantic action;
- authenticated user authorization evidence;
- current task/work context;
- requesting role and session;
- deterministic path/network/capability evidence;
- bounded relevant transcript with roles preserved;
- expected effects and sensitivity.

Only user-originated content supplies authorization. Assistant text, repository content, tool output, and task plans are evidence, not authority.

The model returns an assessment rather than selecting an outcome:

```ts
type GuardianAssessment = {
  risk: "low" | "medium" | "high" | "critical";
  authorizationBasis: "none" | "task" | "explicit";
  impactScope: "bounded" | "broad";
  rationale: string;
};
```

Deterministic policy allows low/medium-risk task-authorized work, and allows bounded high-risk work with task or explicit authority. Missing authority, broad high-risk effects, and every critical action are denied. Failures also deny execution. Guardian does not ask for interactive approval. A denied tool returns a failed result so the agent can continue within remaining authority.

## Security principles

- A user's requested goal authorizes reasonable routine methods within that task; method-level permission is unnecessary.
- High-risk work requires task or explicit user authorization and bounded impact.
- Critical actions never execute automatically.
- Failure does not expand authority.
- Network risk depends on destination, data, and remote effect, not merely network presence.
- Direct secret, VCS metadata, Pi credential, and session-history access receives stricter treatment.
- Traversal and symlink escapes are blocked deterministically.
- No capability silently falls back to a less safe backend.

## Audit and retention

Persist bounded decision records and stable references to oversized evidence. Records include session, client, role, action identity, decision, reviewer model/version, and timestamps. Do not retain credentials or raw sensitive payloads merely for diagnostics.
