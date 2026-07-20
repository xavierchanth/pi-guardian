# ADR 0004: macOS-first shell with a portable core

- Status: Accepted
- Date: 2026-01-15

## Context

The first alpha targets macOS and Zed, but the product should not require a broker rewrite for Windows or Linux. Tauri is cross-platform, while tray, launch, secure storage, IPC, and process APIs remain operating-system specific.

## Decision

Use Tauri for the Host Agent application shell, implemented and accepted on macOS first. Keep broker, event store, protocol, and runtime-supervision logic in portable Rust crates with no Tauri dependencies.

Platform behavior is expressed through narrow adapters. macOS initially uses Unix-domain sockets, Keychain-backed credentials, Launch Services, and macOS startup integration. Future Windows and Linux implementations provide equivalent adapters.

## Consequences

- Core crates can be tested without a WebView or tray runtime.
- Tauri callbacks enqueue broker commands rather than owning state.
- Repository tests reject accidental Tauri dependencies in portable protocol crates.
- macOS-specific hard-coded paths and process commands are prohibited in core modules.
