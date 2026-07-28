# I12 — Stateful machine capabilities

**Status:** Exploratory  
**Depends on:** I02, I03, I04

## Outcome

Browser use, computer control, image generation, and deeper cmux integration are Host-advertised capabilities governed by core policy, Guardian, session persistence, and client authorization.

## Scope

### Shared foundation

- capability descriptors and version negotiation;
- per-Host availability/readiness;
- semantic request/result/event IDs;
- ownership, cancellation, timeout, and idle cleanup;
- Guardian evidence and audit;
- artifact storage/provenance;
- usage/cost accounting;
- client permission and presentation projections.

### Browser

- managed profiles/contexts and credential boundaries;
- navigation, input, download, upload, screenshot, and extraction policy;
- state ownership and takeover;
- durable references to pages/artifacts without assuming browser-process survival.

### Computer use

- display/application target identity;
- observation/action evidence;
- foreground-user interference and emergency stop;
- high-risk action classification;
- remote-control restrictions.

### Image generation

- provider/model selection;
- prompt/provenance retention;
- cost and content policy;
- durable artifacts and client delivery.

### cmux

Scope here is **agent-driven control of cmux surfaces**, which is machine access and needs Guardian
governance. Reporting session status *into* the cmux sidebar is a client concern and belongs to I15;
do not fold the two together.

- terminal/browser surface discovery;
- session-to-surface association;
- lifecycle and stale-handle handling;
- no implicit authority escalation from surface visibility.

## Exit criteria

- Capabilities behave consistently from CLI, desktop, ACP where representable, and remote clients.
- Clients never receive ambient machine credentials/access.
- Stateful adapter loss is reported honestly and does not corrupt session state.
- Every consequential action is attributable to Host, session, client/user authorization, and agent role.
