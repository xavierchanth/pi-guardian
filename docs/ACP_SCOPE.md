# Pi-Tai ACP Scope

## Status

Stage 2 design approved. ACP implementation begins as a thin proof after Host lifecycle, runtime-worker, IPC, and durable broker proofs in [STAGE2_HOST_IMPLEMENTATION_PLAN.md](STAGE2_HOST_IMPLEMENTATION_PLAN.md).

Pi-Tai ACP will be a new, product-owned thin implementation built against the official ACP SDK contracts.

The ACP process does not own Pi sessions. It connects Zed to the separately running Pi-Tai Host tray application over authenticated local IPC. The Host supervises a bundled TypeScript helper that loads Pi through its SDK in-process. See [HOST_ARCHITECTURE.md](HOST_ARCHITECTURE.md).

## Priority legend

- **P0:** required for the first useful Zed alpha.
- **P1:** important follow-up for daily use.
- **P2:** evaluate after the alpha.
- **Out:** intentionally excluded from current scope.

All experimental protocol features must be guarded by negotiated client capabilities.

## Feature matrix

| Area | Feature | Priority | Zed value | Future T3 value | Notes |
|---|---|---:|---:|---:|---|
| Protocol | JSON-RPC over stdio | P0 | Essential | Essential | Official ACP SDK transport. |
| Protocol | Version and capability negotiation | P0 | Essential | Essential | Never assume Zed-only support. |
| Protocol | Agent/client implementation metadata | P0 | Useful | Useful | Include name and version. |
| Protocol | Structured errors and graceful shutdown | P0 | Essential | Essential | Include broken pipe and cancellation. |
| Protocol | Custom `_meta` data | P1 | Limited | High | Use only as optional enhancement. |
| Session | New session | P0 | Essential | Essential | Required ACP method. |
| Session | Prompt and cancel | P0 | Essential | Essential | Required ACP methods. |
| Session | Close active session | P0 | Useful | Essential | Ask the Host to release broker and Pi runtime resources. |
| Session | List sessions | P0 | High | High | Include cwd, title, and update time. |
| Session | Load with history replay | P0 | High | High | Preserve Pi session compatibility. |
| Session | Resume without replay | P1 | Medium | High | Useful for clients retaining history. |
| Session | Delete session | P1 | Medium | Medium | Operate on listed Pi sessions. |
| Session | Pagination and cwd filtering | P1 | Medium | Medium | Needed when history grows. |
| Session | Additional workspace directories | P1 | Medium | High | Useful for monorepos. |
| Session | Fork session | P2 | Medium | High | Experimental ACP operation. |
| Session | Pi tree navigation | Out | Low | Low | Explicitly excluded. |
| Prompt | Text | P0 | Essential | Essential | Baseline ACP content. |
| Prompt | Resource/file links | P0 | High | High | Preserve file references. |
| Prompt | Images | P0 | Medium | Medium | Pi supports image input. |
| Prompt | Embedded resources | P1 | Medium | High | Capability-gated. |
| Prompt | Audio | Out | Low | Low | Explicitly unnecessary. |
| Prompt | Steering and follow-ups | P1 | Medium | High | Map onto Pi queues. |
| Output | Streaming assistant text | P0 | Essential | Essential | Stable message IDs. |
| Output | Separate thought stream | P1 | Medium | Medium | Emit only when client supports useful presentation. |
| Output | User/history replay | P0 | High | High | Avoid duplicates during load. |
| Output | Retry and compaction status | P1 | Medium | Medium | Keep concise. |
| Output | Completion notifications | Out | None | Client-owned | Zed already handles thread completion and attention. |
| Tools | Start/update/end lifecycle | P0 | Essential | Essential | Preserve parallel tool identity. |
| Tools | Human-readable titles | P0 | High | High | Major visual requirement. |
| Tools | Semantic kinds | P0 | High | High | Read, search, execute, edit, delete, move, fetch, think, other. |
| Tools | Raw input/output | P0 | Medium | Medium | Available when expanded. |
| Tools | File locations | P0 | High | High | Enable follow-along. |
| Tools | Accurate line locations | P1 | High | High | Use edit matches when unambiguous. |
| Tools | Structured diffs | P0 | High | Essential | Cover edit, write, create, and delete. |
| Tools | Terminal content | P0 | High | Essential | Present bash as terminal activity. |
| Tools | Streaming terminal output | P1 | High | High | Avoid repeated full snapshots. |
| Tools | Translation/renderer registry | P1 | Medium | High | Allow Pi-Tai custom tools to add semantics. |
| Plans | Stable complete plan update | P0 | High | High | Investigate Codex ACP fixtures first. |
| Plans | Pending/in-progress/completed | P0 | High | High | Mirror work-context state. |
| Plans | Goal metadata | P0 | Medium | High | Keep goal in Pi and Host state even if a client ignores metadata. |
| Plans | External plan replacement | P1 | Low | High | Product API command serialized by the Host and guarded by operation ID and expected revision; not assumed to be standard ACP. |
| Plans | Priorities | P1 | Medium | Medium | Default may be medium. |
| Plans | Multi-plan operations | P2 | Unknown | Medium | Experimental and capability-gated. |
| Plans | File/Markdown plan variants | P2 | Low | Medium | Not needed for initial work context. |
| Config | Main model selector | P0 | Essential | Essential | Separate from title model. |
| Config | Main effort selector | P0 | Essential | Essential | ACP thought-level category. |
| Config | Dynamic config updates | P1 | Medium | High | Refresh after model/auth changes. |
| Config | Boolean options | P1 | Medium | Medium | Capability-gated. |
| Config | Title provider/model/effort | P0 | Medium | Medium | Initially file-configured; ACP controls may follow. |
| Config | Guardian reviewer configuration | P1 | Medium | Medium | Do not expose unsafe bypass as normal mode. |
| Config | Custom access modes | Out | Low | Low | Pi-Tai has one guarded auto workflow. |
| Metadata | Automatic title | P0 | High | High | Generated with configured Luna model. |
| Metadata | Live title update | P0 | High | High | ACP `session_info_update`. |
| Metadata | Context usage and size | P1 | Medium | High | ACP `usage_update`. |
| Metadata | Cumulative cost | P1 | Medium | High | Useful with expensive work models. |
| Commands | Prompt templates | P0 | High | High | Advertise as ACP commands. |
| Commands | Skills | P0 | High | High | Advertise enabled skills. |
| Commands | Extension commands | P1 | Medium | Medium | Exclude TUI-only commands. |
| Commands | Argument hints and updates | P1 | Medium | Medium | Refresh after reload. |
| Permission | ACP permission requests | P0 | High | High | Fallback and extension dialogs. |
| Permission | Guardian automatic decision | P0 | High | High | Primary Pi-Tai gate. |
| Permission | Associate decision with tool | P1 | High | High | Avoid unrelated notification clutter. |
| Permission | Private-data authorization | P0 | Essential | Essential | Preserve Guardian semantics. |
| Auth | Detect missing Pi auth | P0 | Essential | Essential | Return ACP auth-required errors. |
| Auth | Terminal authentication | P0 | High | High | Launch normal Pi login/setup. |
| Auth | Environment auth | P1 | Medium | Medium | Useful in managed environments. |
| Auth | Logout | P1 | Medium | Medium | Stable ACP operation. |
| Filesystem | Client read/write delegation | P2 | Medium | High | Valuable for unsaved buffers, but local Pi tools are sufficient initially. |
| Terminal | Client terminal delegation | P2 | Medium | High | Evaluate against local Pi bash presentation. |
| MCP | stdio/HTTP/SSE/ACP transports | P2 | Low | Medium | Do not block alpha. |
| Provider | Client provider management | P2 | Low | High | Experimental. |
| Elicitation | Form and URL elicitation | P2 | Unknown | High | Client-capability dependent. |
| Editor | Document open/change/save/focus events | P2 | Medium | High | Useful for editor-aware context. |
| Editor | Position encoding negotiation | P2 | Medium | High | Needed for advanced editor integration. |
| NES | Next Edit Suggestions | Out initially | Separate | Potentially high | Treat as a separate product phase. |
| Extensibility | Custom methods/notifications | P2 | Low | High | Useful if T3 becomes a cooperating client. |

## Initial Zed alpha recommendation

The first ACP alpha should include:

- protocol negotiation and authenticated Host IPC;
- actionable Host-not-running and version-mismatch errors;
- new, close, list, and load broker-session flows;
- text, resource-link, image, and cancellation support;
- main model and effort selectors;
- streaming assistant output;
- semantic tool lifecycle, titles, kinds, locations, diffs, and terminal content;
- native execution plans based on Codex ACP research;
- automatic and live session titles;
- commands and skills;
- Guardian enforcement and ACP permission fallback.

## Explicit investigation: Codex plans in Zed

Before implementing plan translation:

1. Pin the current open-source Codex and Codex ACP revisions used for research.
2. Identify the exact ACP messages used for Zed's visible plan UI.
3. Determine whether Zed consumes stable `plan` replacement, experimental `plan_update`, or both.
4. Capture representative protocol payloads as independently authored test fixtures.
5. Verify priority and status rendering in Zed.
6. Implement capability fallback to readable tool output.

The goal is behavioral compatibility with the ACP protocol and Zed, not source compatibility with Codex.

## Host boundary

The ACP shim:

- owns no database or Pi process;
- may be terminated by Zed without cancelling the broker session;
- advertises only capabilities implemented by the complete Zed → shim → Host → Pi pipeline;
- replays normalized Host events rather than reconstructing history from Zed storage;
- leaves non-ACP mobile controls, including external plan editing, on the versioned product API.

Supporting arbitrary downstream ACP agents is out of scope. Pi is the initial and only Host runtime.

## Deferred T3 considerations

A future T3 client may benefit more than Zed from:

- custom `_meta` conventions;
- provider configuration;
- document synchronization;
- client filesystem and terminal delegation;
- elicitation forms;
- session forking;
- custom methods and notifications;
- Next Edit Suggestions.

These should remain separate adapters behind protocol interfaces so Zed compatibility does not depend on T3-specific behavior.
