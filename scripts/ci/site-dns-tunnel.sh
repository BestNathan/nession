#!/usr/bin/env bash
# Owner: #4589. Ubuntu GitHub-hosted job-scoped GOST/WSS tunnel lifecycle for
# the approved AdGuard management endpoint only. Reuses the #1616 ownership
# pattern (tracked PID + birth ticks, owned alias marker, fail-closed
# inspection, always() cleanup) but scopes the relay to the validated
# ADGUARD_API_URL endpoint; the K8s API-only identity tunnel is not proof of
# AdGuard routing. Never touches pods, sessions, tmux or unowned IP aliases.
set -euo pipefail

GOST_BIN="${RUNNER_TEMP:-/tmp}/gost"
API_ALIAS=""
API_PORT=""
LISTENER=""

fail() { echo "::error::site-dns tunnel: $*" >&2; return 1; }

resolve_endpoint() {
  local url="${ADGUARD_API_URL:-}" host port a b c d
  [[ "$url" =~ ^https://([0-9]{1,3}(\.[0-9]{1,3}){3})(:([0-9]{1,5}))?/?$ ]] ||
    { fail 'ADGUARD_API_URL must be a bare https://<internal-IPv4>[:port] endpoint'; return 1; }
  host="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[4]:-443}"
  IFS=. read -r a b c d <<< "$host"
  for octet in "$a" "$b" "$c" "$d"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && (( octet <= 255 )) ||
      { fail 'ADGUARD_API_URL address is not a valid IPv4'; return 1; }
  done
  if (( a != 10 )) && ! { (( a == 172 )) && (( b >= 16 && b <= 31 )); } &&
     ! { (( a == 192 )) && (( b == 168 )); }; then
    fail 'ADGUARD_API_URL must point at internal RFC1918 address space'
    return 1
  fi
  (( port >= 1 && port <= 65535 )) || { fail 'ADGUARD_API_URL port is invalid'; return 1; }
  API_ALIAS="$host"
  API_PORT="$port"
  LISTENER="tcp://${API_ALIAS}:${API_PORT}/${API_ALIAS}:${API_PORT}"
}

ticks() {
  local pid="$1"
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/stat" ]] || return 1
  awk '{print $22}' "/proc/$pid/stat"
}
owned_process() {
  local pid="$1" born="$2" expected_exe="$3" argument="$4" current
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$born" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -e "/proc/$pid/exe" && -r "/proc/$pid/cmdline" ]] || return 1
  [[ "$(readlink -f "/proc/$pid/exe")" == "$(readlink -f "$expected_exe")" ]] || return 1
  current="$(ticks "$pid")" || return 1
  [[ "$born" == "$current" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$argument"
}
stop_owned_pid() {
  local file="$1" exe="$2" argument="$3" pid born extra i
  [[ -f "$file" ]] || return 0
  if ! read -r pid born extra < "$file" || [[ -n "${extra:-}" ]] ||
     [[ ! "$pid" =~ ^[1-9][0-9]*$ || ! "$born" =~ ^[1-9][0-9]*$ ]]; then
    rm -f -- "$file"
    fail 'malformed owned PID marker (no process killed)'
    return 1
  fi
  if owned_process "$pid" "$born" "$exe" "$argument"; then
    kill -TERM "$pid" 2>/dev/null || true
    for i in {1..20}; do
      owned_process "$pid" "$born" "$exe" "$argument" || break
      sleep 0.1
    done
    if owned_process "$pid" "$born" "$exe" "$argument"; then
      kill -KILL "$pid" 2>/dev/null || true
      sleep 0.1
    fi
    if owned_process "$pid" "$born" "$exe" "$argument"; then
      rm -f -- "$file"
      fail 'owned tunnel process survived bounded termination'
      return 1
    fi
  fi
  rm -f -- "$file"
}
alias_present() {
  local observed
  observed="$(sudo ip -o -4 addr show dev lo)" || return 2
  grep -Eq "inet[[:space:]]${API_ALIAS//./[.]}/32([[:space:]]|$)" <<< "$observed"
}
cleanup_alias() {
  local marker="$RUNNER_TEMP/gost-site-alias-owned"
  # An alias that predated this job must never be removed.
  [[ -f "$marker" ]] || return 0
  local inspect_status=0
  if alias_present; then
    sudo ip addr del "$API_ALIAS/32" dev lo ||
      { fail 'could not remove job-owned loopback alias'; return 1; }
  else
    inspect_status=$?
    if (( inspect_status != 1 )); then
      fail 'could not inspect job-owned loopback alias; preserving marker'
      return 1
    fi
  fi
  rm -f -- "$marker"
}
cleanup() {
  local state=0
  if [[ -n "$LISTENER" ]]; then
    stop_owned_pid "$RUNNER_TEMP/gost-site.pid" "$GOST_BIN" "$LISTENER" || state=1
    cleanup_alias || state=1
  fi
  # Remove only known job-owned files. Do not clean arbitrary host processes,
  # sockets, tmux, user workloads or entire runner temporary directories.
  rm -f -- "$RUNNER_TEMP/gost-site.log" "$RUNNER_TEMP/gost" "$RUNNER_TEMP/gost.tgz" \
    "$RUNNER_TEMP/site-plan.json" "$RUNNER_TEMP/site-plan-receipt.json" \
    "$RUNNER_TEMP/site-result-receipt.json" "$RUNNER_TEMP/gitops-revision"
  ((state == 0)) || return 1
  echo 'SITE_DNS_CLEANUP_V1 status=success owned_pid=stopped alias=removed scope=job'
}
start() {
  [[ -n "${GOST_RELAY_URL:-}" && -x "$GOST_BIN" ]] ||
    { fail 'trusted relay or GOST executable unavailable'; return 1; }
  resolve_endpoint || return 1
  [[ ! -e "$RUNNER_TEMP/gost-site.pid" && ! -e "$RUNNER_TEMP/gost-site-alias-owned" ]] ||
    { fail 'stale job-owned network state exists; cleanup required'; return 1; }
  local inspect_status=0
  if alias_present; then
    fail 'AdGuard endpoint alias already exists; refusing to borrow or remove unowned state'
    return 1
  else
    inspect_status=$?
    if (( inspect_status != 1 )); then
      fail 'cannot verify that endpoint alias is unowned; refusing to create tunnel'
      return 1
    fi
  fi
  sudo ip addr add "$API_ALIAS/32" dev lo
  : > "$RUNNER_TEMP/gost-site-alias-owned"
  nohup "$GOST_BIN" -L "$LISTENER" -F "$GOST_RELAY_URL" \
    > "$RUNNER_TEMP/gost-site.log" 2>&1 &
  local pid="$!" born="" i
  for i in {1..10}; do
    born="$(ticks "$pid" || true)"
    [[ "$born" =~ ^[1-9][0-9]*$ ]] && break
    sleep 0.1
  done
  [[ "$born" =~ ^[1-9][0-9]*$ ]] ||
    { fail 'could not pin the owned GOST process identity'; return 1; }
  printf '%s %s\n' "$pid" "$born" > "$RUNNER_TEMP/gost-site.pid"
  for i in {1..15}; do
    # Routing-only readiness probe: any HTTP status (including 401 without
    # credentials) proves the approved endpoint is reachable through the
    # owned tunnel. Actual API calls perform full TLS validation separately.
    if curl -ksS --max-time 2 --output /dev/null \
      "https://${API_ALIAS}:${API_PORT}/control/status" 2>/dev/null; then
      owned_process "$pid" "$born" "$GOST_BIN" "$LISTENER" ||
        { fail 'tunnel readiness does not belong to the tracked GOST process'; return 1; }
      # This probes only loopback, never an unauthorized private LAN target.
      if timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/${API_PORT}" \
          >/dev/null 2>&1; then
        fail 'listener accepts an unallowlisted local destination'
        return 1
      fi
      echo 'SITE_DNS_TUNNEL_V1 status=ready endpoint=adguard-only off_alias=denied'
      return 0
    fi
    sleep 2
  done
  fail 'approved AdGuard endpoint tunnel unavailable (relay log suppressed)'
}

self_test() {
  local temp owned unrelated stubborn exe born
  temp="$(mktemp -d)"
  RUNNER_TEMP="$temp"
  ADGUARD_API_URL='https://192.168.2.53:8443'
  trap 'kill "${owned:-}" "${unrelated:-}" "${stubborn:-}" 2>/dev/null || true; rm -rf -- "${temp:-}"' EXIT
  resolve_endpoint
  [[ "$API_ALIAS" == '192.168.2.53' && "$API_PORT" == '8443' ]]
  # Endpoint validation negatives.
  local bad
  for bad in 'http://192.168.2.53' 'https://8.8.4.4' 'https://192.168.2.53/control' \
             'https://192.168.2.53:99999' 'https://adguard.internal.example'; do
    ADGUARD_API_URL="$bad"
    if resolve_endpoint >/dev/null 2>&1; then
      fail 'endpoint validation accepted a disallowed URL'; return 1
    fi
  done
  ADGUARD_API_URL='https://192.168.2.53:8443'
  resolve_endpoint
  exe="$(readlink -f "$(command -v sleep)")"
  sleep 20 & owned=$!
  sleep 20 & unrelated=$!
  born="$(ticks "$owned")"
  printf '%s %s\n' "$owned" "$born" > "$temp/gost-site.pid"
  owned_process "$owned" "$born" "$exe" 'sleep 20'
  # A copied marker with the wrong process birth time must not kill anything.
  printf '%s %s\n' "$unrelated" "$(( $(ticks "$unrelated") + 1 ))" > "$temp/forged.pid"
  stop_owned_pid "$temp/forged.pid" "$exe" 'sleep 20'
  kill -0 "$unrelated"
  stop_owned_pid "$temp/gost-site.pid" "$exe" 'sleep 20'
  ! owned_process "$owned" "$born" "$exe" 'sleep 20'
  stop_owned_pid "$temp/gost-site.pid" "$exe" 'sleep 20' # idempotent
  kill -0 "$unrelated" # never touch unowned processes
  # Simulate a timed-out child ignoring TERM; enforce bounded KILL fallback.
  bash -c 'trap "" TERM; exec sleep 20' & stubborn=$!
  sleep 0.1
  printf '%s %s\n' "$stubborn" "$(ticks "$stubborn")" > "$temp/stubborn.pid"
  stop_owned_pid "$temp/stubborn.pid" "$exe" 'sleep 20'
  ! owned_process "$stubborn" "$(ticks "$stubborn" || echo 0)" "$exe" 'sleep 20'
  kill -0 "$unrelated"
  printf '%s' 'malformed' > "$temp/gost-site.pid"
  if stop_owned_pid "$temp/gost-site.pid" "$exe" 'sleep 20' 2>/dev/null; then
    fail 'forged PID marker must fail closed'; return 1
  fi
  kill -0 "$unrelated"
  # Stub privileged ip to prove ownership-marker-scoped cleanup.
  local fake_alias=1 deletes=0 additions=0 fake_error=0
  sudo() {
    if [[ "$*" == 'ip -o -4 addr show dev lo' ]]; then
      (( fake_error == 0 )) || return 1
      ((fake_alias)) && echo '1: lo inet 192.168.2.53/32 scope host lo'
    elif [[ "$*" == 'ip addr del 192.168.2.53/32 dev lo' ]]; then
      ((deletes+=1)); fake_alias=0
    elif [[ "$*" == 'ip addr add 192.168.2.53/32 dev lo' ]]; then
      ((additions+=1)); fake_alias=1
    else
      fail 'unexpected privileged self-test command'
    fi
  }
  cleanup_alias # no marker, must not remove a pre-existing alias
  [[ "$deletes" == 0 ]]
  : > "$temp/gost-site-alias-owned"
  cleanup_alias
  cleanup_alias
  [[ "$deletes" == 1 && ! -e "$temp/gost-site-alias-owned" ]]
  : > "$temp/gost-site.log"
  : > "$temp/gost"
  : > "$temp/gost.tgz"
  : > "$temp/site-plan-receipt.json"
  : > "$temp/foreign-owned-file"
  cleanup
  [[ ! -e "$temp/gost-site.log" && ! -e "$temp/gost" &&
     ! -e "$temp/gost.tgz" && ! -e "$temp/site-plan-receipt.json" &&
     -e "$temp/foreign-owned-file" ]]
  kill -0 "$unrelated"
  # Failure to inspect the current alias must not lead to borrowing/removing it.
  GOST_BIN="$exe"
  GOST_RELAY_URL='fixture-only'
  fake_alias=0
  fake_error=1
  if start >/dev/null 2>&1; then
    fail 'startup must reject an uninspectable alias'; return 1
  fi
  [[ "$additions" == 0 && ! -e "$temp/gost-site-alias-owned" &&
     ! -e "$temp/gost-site.pid" ]]
  fake_error=0
  kill "$unrelated" 2>/dev/null || true
  echo 'Site DNS tunnel: endpoint validation, live child TERM/KILL timeout, forged/replayed PID, fail-closed alias inspection, owned cleanup and idempotency passed'
}

[[ "${1:-}" == 'self-test' ]] || [[ -n "${RUNNER_TEMP:-}" ]] ||
  { fail 'RUNNER_TEMP is required'; exit 1; }
case "${1:-}" in
  start)
    # This process owns only startup; the workflow's always() cleanup owns
    # shutdown across subsequent Actions steps. Failed/signal-interrupted
    # startup must also self-clean, even before later Actions steps can run.
    trap 'cleanup' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    start
    trap - EXIT INT TERM HUP
    ;;
  cleanup) cleanup ;;
  self-test) self_test ;;
  *) fail 'usage: site-dns-tunnel.sh <start|cleanup|self-test>'; exit 1 ;;
esac
