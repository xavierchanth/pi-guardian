# ADR 0005: Package the runtime worker as a Bun standalone executable

- Status: Accepted
- Date: 2026-07-22

## Context

The Pi runtime worker must ship inside the Pi-Tai installation and start without a user-managed Node or Bun installation. H2 compared three artifacts built from the same worker entry point:

1. a Bun standalone executable;
2. a Node 24 Single Executable Application (SEA);
3. a private Node 24 sidecar plus an ESM worker bundle.

The comparison ran on macOS with Bun 1.3.14 and Node 24.18.0. Each viable candidate was copied into a fresh temporary directory, launched with a stripped `PATH`, and exercised through protocol initialization, Pi session creation, hosted Pi-Tai loading, faux-model streaming, `update_plan` execution, cancellation, shutdown, and session-file parsing. Readiness was sampled over ten process launches. Generated artifacts and raw measurements remain ignored under `dist/runtime-packaging/`.

## Evidence

| Candidate | Artifact size | Readiness median / p95 | Idle / active RSS | Black-box result |
|---|---:|---:|---:|---|
| Bun standalone | 81,163,490 bytes | 213.5 / 961.9 ms | 178,064 / 179,824 KiB | Passed |
| Node SEA | 84,499,344 bytes | n/a | n/a | Failed before `runtime.initialize` with `SIGSEGV` |
| Private Node sidecar | 84,791,892 bytes | 303.1 / 868.9 ms | 246,176 / 248,800 KiB | Passed |

The readiness p95 includes cold-start noise and is not a latency service-level objective. Bun had the smaller artifact, lower median readiness time, and substantially lower measured memory. The private Node sidecar remained a functional fallback. The SEA pipeline required post-link blob injection and produced an artifact that crashed before protocol startup in the proof environment.

## Decision

Package `pi-tai-runtime` as a Bun standalone executable, built with the exact-pinned and acceptance-tested Bun toolchain used by release automation. The artifact contains the worker, Pi SDK dependencies, Pi-Tai hosted extension, and embedded prompt resources; it must not depend on repository source files or a user runtime installation.

Retain the private Node sidecar builder as a comparison and fallback path during Stage 2. Do not ship the current Node SEA candidate.

`npm run runtime:smoke` is the packaging acceptance command. It builds all candidates, requires the Bun candidate to pass, and records comparison JSON under ignored build output. A rejected candidate may remain in the report without making the selected Bun acceptance fail.

## Consequences

- Release packaging must pin Bun and run the packaged black-box smoke test on each supported target.
- The Host can supervise one self-contained worker executable without discovering Node or Bun on the user's `PATH`.
- Hosted resources must be statically bundled or embedded rather than resolved from repository-relative paths.
- Signing, notarization, universal binaries, and Windows/Linux artifact production remain later release gates.
- Packaging is revisited if Bun cannot satisfy those gates or materially regresses startup, memory, or Pi SDK compatibility.
