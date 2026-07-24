# I11 — Remote and multi-Host access

**Status:** Exploratory  
**Depends on:** I04, I10

## Outcome

Authenticated remote clients can observe and control sessions without changing the one-home-Host authority model. A client may discover several Hosts and route commands to the correct one.

## Stages

1. **Remote observer:** pair device, list sessions, snapshots, cursor replay, live events.
2. **Remote control:** prompts, steering, cancellation, interaction answers, plan/config updates under revisions.
3. **Multi-Host discovery:** one client catalogs Hosts and resolves session home.
4. **Optional control plane:** aggregate metadata/routing without becoming a second session writer.
5. **Future migration:** explicit quiesced session transfer only after a concrete need.

## Required design

- Host/device identity and key lifecycle;
- product-level pairing even when Tailscale provides network reachability;
- encrypted authenticated transport;
- permissions for observe, control, capabilities, and administration;
- reconnect cursor and replay barrier over unreliable networks;
- Host availability and offline state;
- explicit session-home identity;
- audit attribution for remote commands.

## Non-goals for initial remote work

- active-active session replication;
- transparent live-workspace migration;
- public unauthenticated listener;
- sending machine credentials to clients;
- treating all Hosts as sharing filesystems/capabilities.

## Exit criteria

- Remote detach/reconnect loses no durable events.
- One session cannot have two authoritative writers.
- Remote capability calls pass through the same Guardian/Host boundary.
- Control-plane failure cannot corrupt or take ownership of Host sessions.
