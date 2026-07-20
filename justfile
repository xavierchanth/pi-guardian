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

# Run type checking and all automated tests.
check:
    npm run check

# Verify package contents without publishing.
package-check:
    npm run package:check

# Load only Pi-Tai in offline RPC mode and verify its extension commands.
smoke:
    npm run smoke:isolated
