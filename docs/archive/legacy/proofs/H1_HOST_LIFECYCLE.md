# H1 macOS Host Agent lifecycle proof

## Scope

This disposable proof validates tray-owned lifetime before broker or Pi runtime implementation. The readiness socket returns fixed process health only. It is private (`0700` parent and `0600` socket) but deliberately not the authenticated product IPC planned for H3.

## Automated proof

On macOS:

```bash
just host-lifecycle-smoke
```

The proof builds the Tauri application, opens and programmatically closes its diagnostics WebView, probes the readiness socket, and verifies that a second copy delegates to the existing process. It then verifies clean idle quit plus active-turn warning and explicit confirmation paths, including readiness-socket cleanup.

Portable lifecycle and platform adapters are covered by:

```bash
cargo test -p pi-tai-host-lifecycle -p pi-tai-host-platform
```

## Manual tray proof

1. Start the proof:

   ```bash
   cargo run -p pi-tai-host-agent
   ```

2. Confirm the **Pi-Tai Host Agent** tray icon appears.
3. Choose **Open Diagnostics**, then close the window.
4. Confirm the tray icon remains and **Open Diagnostics** restores the same window.
5. From another terminal, run `cargo run -p pi-tai-host-agent`. Confirm it exits and focuses the existing diagnostics window rather than creating another Host Agent.
6. Choose **Quit Pi-Tai Host Agent** and confirm the process and readiness socket exit.

## Active-turn warning proof

H2 does not exist yet, so H1 exposes a proof-only environment variable:

```bash
PI_TAI_PROOF_ACTIVE_TURNS=1 cargo run -p pi-tai-host-agent
```

Choosing **Quit Pi-Tai Host Agent** keeps the process alive, opens diagnostics with an interruption warning in its title, and records a structured `host.quit_warning` diagnostic. Choosing **Confirm Quit and Interrupt Active Turns** is the explicit second decision and exits. The portable lifecycle tests verify that confirmation is accepted only after a warning.
