#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "H1 Host Agent lifecycle proof is macOS-only; skipped."
  exit 0
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
cargo build -p pi-tai-host-agent

binary="$root/target/debug/pi-tai-host-agent"
temp_dir="$(mktemp -d /tmp/pi-tai-host-lifecycle.XXXXXX)"
first_log="$temp_dir/first.log"
second_log="$temp_dir/second.log"
active_log="$temp_dir/active.log"
endpoint=""
active_pid=""
PI_TAI_PROOF_AUTO_CLOSE_MS=250 "$binary" >"$first_log" 2>&1 &
host_pid=$!

cleanup() {
  kill "$host_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
  if [[ -n "$active_pid" ]]; then
    kill "$active_pid" 2>/dev/null || true
    wait "$active_pid" 2>/dev/null || true
  fi
  [[ -n "$endpoint" ]] && rm -f "$endpoint"
  rm -rf "$temp_dir"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  grep -q 'host.window_hidden' "$first_log" && break
  if ! kill -0 "$host_pid" 2>/dev/null; then
    cat "$first_log"
    exit 1
  fi
  sleep .05
done
grep -q 'host.window_hidden' "$first_log"

endpoint="$(python3 - "$first_log" <<'PY'
import json
import sys
for line in open(sys.argv[1]):
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("event") == "host.ready":
        print(event["endpoint"])
        break
PY
)"

python3 - "$endpoint" "$host_pid" <<'PY'
import json
import socket
import sys
stream = socket.socket(socket.AF_UNIX)
stream.connect(sys.argv[1])
data = b""
while part := stream.recv(4096):
    data += part
status = json.loads(data)
assert status["status"] == "ready", status
assert status["pid"] == int(sys.argv[2]), status
PY

"$binary" >"$second_log" 2>&1 &
second_pid=$!
for _ in $(seq 1 100); do
  ! kill -0 "$second_pid" 2>/dev/null && break
  sleep .05
done
if kill -0 "$second_pid" 2>/dev/null; then
  echo "Second Host Agent did not delegate to the existing instance." >&2
  cat "$second_log" >&2
  kill "$second_pid"
  exit 1
fi
wait "$second_pid"

for _ in $(seq 1 100); do
  grep -q 'host.second_launch' "$first_log" && break
  sleep .05
done
grep -q 'host.second_launch' "$first_log"
kill -0 "$host_pid"

python3 - "$endpoint" <<'PY'
import json
import socket
import sys
stream = socket.socket(socket.AF_UNIX)
stream.connect(sys.argv[1])
data = b""
while part := stream.recv(4096):
    data += part
assert json.loads(data)["status"] == "ready"
PY

"$binary" --proof-request-quit >"$second_log" 2>&1
for _ in $(seq 1 100); do
  ! kill -0 "$host_pid" 2>/dev/null && break
  sleep .05
done
if kill -0 "$host_pid" 2>/dev/null; then
  echo "Idle Host Agent did not quit cleanly." >&2
  exit 1
fi
wait "$host_pid"
for _ in $(seq 1 100); do
  [[ ! -e "$endpoint" ]] && break
  sleep .05
done
[[ ! -e "$endpoint" ]]

PI_TAI_PROOF_ACTIVE_TURNS=1 "$binary" >"$active_log" 2>&1 &
active_pid=$!
for _ in $(seq 1 100); do
  grep -q 'host.ready' "$active_log" && break
  if ! kill -0 "$active_pid" 2>/dev/null; then
    cat "$active_log"
    exit 1
  fi
  sleep .05
done
grep -q 'host.ready' "$active_log"
endpoint="$(python3 - "$active_log" <<'PY'
import json
import sys
for line in open(sys.argv[1]):
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("event") == "host.ready":
        print(event["endpoint"])
        break
PY
)"

"$binary" --proof-request-quit >"$second_log" 2>&1
for _ in $(seq 1 100); do
  grep -q 'host.quit_warning' "$active_log" && break
  sleep .05
done
grep -q 'host.quit_warning' "$active_log"
kill -0 "$active_pid"
python3 - "$endpoint" <<'PY'
import json
import socket
import sys
stream = socket.socket(socket.AF_UNIX)
stream.connect(sys.argv[1])
assert json.loads(stream.recv(4096))["status"] == "ready"
PY

"$binary" --proof-confirm-quit >"$second_log" 2>&1
for _ in $(seq 1 100); do
  ! kill -0 "$active_pid" 2>/dev/null && break
  sleep .05
done
if kill -0 "$active_pid" 2>/dev/null; then
  echo "Active Host Agent did not honor explicit quit confirmation." >&2
  exit 1
fi
wait "$active_pid"
for _ in $(seq 1 100); do
  [[ ! -e "$endpoint" ]] && break
  sleep .05
done
[[ ! -e "$endpoint" ]]

echo "H1 macOS lifecycle proof passed."
