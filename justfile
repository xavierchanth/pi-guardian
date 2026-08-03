set export

root := justfile_directory()

# List available Pi-Tai development commands.
default:
    @just --list

# Start an isolated Pi instance with only Pi-Tai loaded; optionally provide one prompt.
pi-tai prompt="":
    #!/usr/bin/env bash
    set -euo pipefail
    cd "$root"
    if [[ -n "$prompt" ]]; then
      exec pi -ne -e "$root" "$prompt"
    else
      exec pi -ne -e "$root"
    fi

alias pitai := pi-tai
alias pi := pi-tai

# Install the exact development dependencies from package-lock.json.
setup:
    npm ci

# Apply the repository's deterministic TypeScript formatting.
format:
    npm run format

# Check deterministic formatting without changing files.
format-check:
    npm run format:check

# Run the repository TypeScript linter.
lint:
    npm run lint

# Run formatting, linting, TypeScript, Node, and Rust checks.
check:
    npm run check

# Check Rust formatting and lint all workspace targets with warnings denied, then run tests.
rust-check:
    npm run rust:check

# Apply deterministic Rust formatting across the workspace.
rust-format:
    cargo fmt --all

# Check deterministic Rust formatting without changing files.
rust-format-check:
    cargo fmt --all -- --check

# Lint all Rust workspace targets with warnings denied.
rust-clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Regenerate Rust-first TypeScript runtime protocol DTOs.
protocol-generate:
    npm run protocol:generate

# Verify package contents without publishing.
package-check:
    npm run package:check

# Run the packaged runtime black-box smoke suite.
runtime-smoke:
    npm run runtime:smoke

# Build and measure all H2 runtime packaging candidates.
runtime-package-compare:
    npm run runtime:package-compare

# Load only Pi-Tai in offline RPC mode and verify its extension commands.
smoke:
    npm run smoke:isolated

# Run the macOS Tauri Host Agent lifecycle proof.
host-lifecycle-smoke:
    bash tests/smoke/host-lifecycle-macos.sh
