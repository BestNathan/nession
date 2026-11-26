#!/usr/bin/env bash
# Native macOS release-mode runtime fixture (#4584 SC-02).
#
# Drives the REAL release binaries — the `nession agent start -f` foreground
# CLI path (the reported v1.0.0 crash boundary) and the standalone
# `nession-agent` binary — against a real local Server and isolated tmux
# inventories of 1 and 106 existing Sessions. For each scenario it proves:
#
#   * registration succeeds and the Agent stays alive across >= 3 heartbeats
#     publishing the expected Session inventory;
#   * an explicit `server.session.processes` request returns a real macOS
#     snapshot (exercising proc_pid_rusage / proc_pidinfo on demand);
#   * the Agent survives a Server restart (reconnect + re-registration);
#   * SIGTERM shuts down cleanly (exit 0, not a fatal signal) without losing
#     the observed Sessions or touching any non-owned tmux server.
#
# Everything lives under a private short-path work dir with an isolated
# NESSION_HOME / NESSION_RUNTIME_DIR and a private `tmux -S` socket; the user's
# default tmux server is never addressed. On failure it emits sanitized
# diagnostics and any macOS crash report for the Agent process.
#
# usage: native-macos-runtime-check.sh BIN_DIR [WORK_DIR]
#   BIN_DIR  directory holding release nession / nession-agent / nession-server
#   WORK_DIR optional parent for the private run dir (default: mktemp under /tmp)
#
# Requires: bash, node >= 22 (built-in WebSocket), tmux. macOS only.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "native-macos-runtime-check: macOS only (got $(uname -s))" >&2
  exit 2
fi

BIN_DIR="${1:?usage: native-macos-runtime-check.sh BIN_DIR [WORK_DIR]}"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
for bin in nession nession-agent nession-server; do
  [[ -x "$BIN_DIR/$bin" ]] || { echo "missing release binary: $BIN_DIR/$bin" >&2; exit 2; }
done
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 2; }
command -v node >/dev/null || { echo "node >= 22 is required" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER="$SCRIPT_DIR/lib/native-macos-runtime-driver.mjs"
[[ -f "$DRIVER" ]] || { echo "missing driver: $DRIVER" >&2; exit 2; }

# Short path: a unix socket path is capped at 103 bytes; macOS $TMPDIR is long.
WORK_PARENT="${2:-/tmp}"
RUN_DIR="$(mktemp -d "$WORK_PARENT/nession-native-XXXXXX")"
TOKEN="native-fixture-token"
AGENT_ID="native-fixture-agent"
SUMMARY="$RUN_DIR/summary.json"
echo '{"scenarios":[]}' > "$SUMMARY"

AGENT_PID=""
SERVER_PID=""
CUR_SOCKET=""

cleanup() {
  local rc=$?
  [[ -n "$AGENT_PID" ]] && kill -TERM "$AGENT_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  [[ -n "$AGENT_PID" ]] && wait "$AGENT_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  # Only ever the private socket this fixture created — never the default server.
  [[ -n "$CUR_SOCKET" && -S "$CUR_SOCKET" ]] && tmux -S "$CUR_SOCKET" kill-server 2>/dev/null || true
  if [[ $rc -ne 0 ]]; then
    echo "::error::native macOS runtime fixture failed (rc=$rc); diagnostics in $RUN_DIR" >&2
    collect_crash_reports
  else
    rm -rf "$RUN_DIR"
  fi
  exit $rc
}
trap cleanup EXIT

collect_crash_reports() {
  local dest="$RUN_DIR/crash-reports"
  mkdir -p "$dest"
  local d
  for d in "$HOME/Library/Logs/DiagnosticReports" "/Library/Logs/DiagnosticReports"; do
    [[ -d "$d" ]] || continue
    # Only nession-related reports from this run window; redact nothing else.
    find "$d" -maxdepth 1 -name 'nession*' -mmin -10 2>/dev/null | while read -r f; do
      cp "$f" "$dest/" 2>/dev/null || true
    done
  done
}

pick_port() {
  node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close();});'
}

# wait_for_log FILE PATTERN TIMEOUT_SECS — poll until grep matches.
wait_for_log() {
  local file="$1" pattern="$2" timeout="$3" waited=0
  while (( waited < timeout )); do
    grep -qE "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.5
    waited=$((waited + 1))
  done
  echo "timed out (${timeout}s) waiting for /$pattern/ in $file" >&2
  return 1
}

count_log() { grep -cE "$2" "$1" 2>/dev/null || true; }

record() {
  # record NAME JSON — append a scenario result to the summary.
  node -e '
    const fs=require("fs");const [f,name,json]=process.argv.slice(1);
    const s=JSON.parse(fs.readFileSync(f,"utf8"));
    s.scenarios.push(Object.assign({name},JSON.parse(json)));
    fs.writeFileSync(f,JSON.stringify(s,null,2));
  ' "$SUMMARY" "$1" "$2"
}

# run_scenario COUNT MODE(cli|standalone)
run_scenario() {
  local count="$1" mode="$2"
  local name="${mode}-${count}"
  local dir="$RUN_DIR/$name"
  mkdir -p "$dir/home" "$dir/runtime" "$dir/work" "$dir/blobs" "$dir/build"
  local socket="$dir/tmux.sock"
  CUR_SOCKET="$socket"
  local server_port agent_port
  server_port="$(pick_port)"
  agent_port="$(pick_port)"
  local server_cfg="$dir/server.toml" agent_cfg="$dir/agent.toml"
  local server_log="$dir/server.log" agent_log="$dir/agent.log"

  cat > "$server_cfg" <<EOF
listen_address = "127.0.0.1:${server_port}"
tls_cert_path = ""
tls_key_path = ""
auth_token = "${TOKEN}"
heartbeat_interval_secs = 2
heartbeat_timeout_secs = 30
db_path = "${dir}/server.db"
image_blob_dir = "${dir}/blobs"
image_build_dir = "${dir}/build"
EOF

  cat > "$agent_cfg" <<EOF
agent_id = "${AGENT_ID}"
server_url = "ws://127.0.0.1:${server_port}"
auth_token = "${TOKEN}"
agent_token = "native-fixture-inbound-token"
listen_address = "127.0.0.1:${agent_port}"
heartbeat_interval_secs = 2
session_poll_interval_secs = 1
tmux_socket_path = "${socket}"
default_working_dir = "${dir}/work"
disable_address_autodetect = true
EOF

  export NESSION_HOME="$dir/home"
  export NESSION_RUNTIME_DIR="$dir/runtime"
  export HOME="$dir/home"

  # Existing inventory: create the Sessions BEFORE the Agent starts, on the
  # private socket the Agent will observe. The default tmux server is untouched.
  local i
  for ((i = 0; i < count; i++)); do
    tmux -S "$socket" new-session -d -s "native-sess-${i}" -x 80 -y 24
  done
  local created
  created="$(tmux -S "$socket" list-sessions -F '#{session_name}' | wc -l | tr -d ' ')"
  [[ "$created" == "$count" ]] || { echo "inventory setup: expected $count sessions, got $created" >&2; return 1; }

  # Start the real local Server.
  "$BIN_DIR/nession-server" "$server_cfg" >"$server_log" 2>&1 &
  SERVER_PID=$!
  wait_for_log "$server_log" "listening|Listening|started|Started" 20 || {
    echo "server did not start; log:" >&2; tail -30 "$server_log" >&2; return 1; }

  # Start the Agent under test (release mode, real process boundary).
  if [[ "$mode" == "cli" ]]; then
    "$BIN_DIR/nession" agent start -f --config "$agent_cfg" >"$agent_log" 2>&1 &
  else
    "$BIN_DIR/nession-agent" "$agent_cfg" >"$agent_log" 2>&1 &
  fi
  AGENT_PID=$!

  # Registration + >= 3 heartbeats publishing the expected inventory.
  wait_for_log "$agent_log" "registration accepted" 30 || {
    echo "agent did not register; log:" >&2; tail -40 "$agent_log" >&2; return 1; }
  wait_for_log "$agent_log" "Sending heartbeat: sessions=${count}," 30 || {
    echo "agent did not publish sessions=${count}; log:" >&2; tail -40 "$agent_log" >&2; return 1; }
  local hb=0 waited=0
  while (( waited < 40 )); do
    hb="$(count_log "$agent_log" 'Sending heartbeat: sessions=')"
    (( hb >= 3 )) && break
    sleep 0.5; waited=$((waited + 1))
  done
  (( hb >= 3 )) || { echo "expected >=3 heartbeats, got $hb" >&2; return 1; }
  kill -0 "$AGENT_PID" 2>/dev/null || { echo "agent died during heartbeats" >&2; collect_crash_reports; return 1; }

  # Explicit on-demand process discovery through the Server relay.
  local discovery
  discovery="$(node "$DRIVER" "ws://127.0.0.1:${server_port}/ws" "$TOKEN" "${AGENT_ID}:native-sess-0")" || {
    echo "process discovery failed: $discovery" >&2; return 1; }
  node -e 'const r=JSON.parse(process.argv[1]);if(!r.ok||r.platform!=="macos"||r.pane_count<1||r.process_count<1){console.error("bad snapshot: "+process.argv[1]);process.exit(1);}' "$discovery" || return 1

  # Reconnect: restart the Server (same durable db) and require re-registration.
  local regs_before
  regs_before="$(count_log "$agent_log" 'registration accepted')"
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  "$BIN_DIR/nession-server" "$server_cfg" >"$server_log.restart" 2>&1 &
  SERVER_PID=$!
  wait_for_log "$agent_log" "registration accepted" 40 || true
  local regs_after=0 waited2=0
  while (( waited2 < 60 )); do
    regs_after="$(count_log "$agent_log" 'registration accepted')"
    (( regs_after > regs_before )) && break
    sleep 0.5; waited2=$((waited2 + 1))
  done
  (( regs_after > regs_before )) || { echo "agent did not re-register after server restart" >&2; tail -40 "$agent_log" >&2; return 1; }
  kill -0 "$AGENT_PID" 2>/dev/null || { echo "agent died across reconnect" >&2; collect_crash_reports; return 1; }

  # Clean shutdown: SIGTERM must exit 0, not a fatal signal (SIGBUS/SIGSEGV).
  kill -TERM "$AGENT_PID"
  local agent_rc=0
  wait "$AGENT_PID" || agent_rc=$?
  AGENT_PID=""
  if (( agent_rc != 0 )); then
    echo "agent shutdown exit=$agent_rc (expected 0; >128 means fatal signal $((agent_rc - 128)))" >&2
    collect_crash_reports
    return 1
  fi
  wait_for_log "$agent_log" "Shutdown signal received" 10 || true

  # Sessions survive; the private tmux server still holds the full inventory.
  local survived
  survived="$(tmux -S "$socket" list-sessions -F '#{session_name}' 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$survived" == "$count" ]] || { echo "session loss: expected $count, survived $survived" >&2; return 1; }

  # Tear down this scenario's server and private tmux server.
  kill -TERM "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  tmux -S "$socket" kill-server 2>/dev/null || true
  CUR_SOCKET=""

  record "$name" "{\"ok\":true,\"mode\":\"$mode\",\"sessions\":$count,\"heartbeats\":$hb,\"reconnect_registrations\":$regs_after,\"discovery\":$discovery,\"agent_exit\":$agent_rc,\"sessions_survived\":$survived}"
  echo "scenario $name: OK (heartbeats=$hb, discovery=$discovery)"
}

run_scenario 1 cli
run_scenario 106 cli
run_scenario 1 standalone

echo "native macOS runtime fixture: all scenarios passed"
cat "$SUMMARY"