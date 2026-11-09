#!/usr/bin/env bash
# Owner: #1616. Ubuntu GitHub-hosted job-scoped GOST/WSS tunnel lifecycle.
# This never touches pods, sessions, tmux, deployments or unowned IP aliases.
set -euo pipefail

API_ALIAS=192.168.2.162
API_PORT=6443
GOST_BIN=/tmp/gost
LISTENER="tcp://${API_ALIAS}:${API_PORT}/${API_ALIAS}:${API_PORT}"

fail() { echo "::error::deploy-identity tunnel: $*" >&2; return 1; }
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
  tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$argument"
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
  sudo ip -o -4 addr show dev lo |
    grep -Eq 'inet[[:space:]]+192[.]168[.]2[.]162/32([[:space:]]|$)'
}
cleanup_alias() {
  local marker="$RUNNER_TEMP/gost-ci-alias-owned"
  # An alias that predated this job must never be removed.
  [[ -f "$marker" ]] || return 0
  if alias_present; then
    sudo ip addr del "$API_ALIAS/32" dev lo ||
      { fail 'could not remove job-owned loopback alias'; return 1; }
  fi
  rm -f -- "$marker"
}
cleanup() {
  local state=0
  stop_owned_pid "$RUNNER_TEMP/gost-ci.pid" "$GOST_BIN" "$LISTENER" || state=1
  cleanup_alias || state=1
  # Remove only known job-owned files. Do not clean arbitrary host processes,
  # sockets, tmux, user workloads or entire runner temporary directories.
  rm -f -- "$RUNNER_TEMP/nession-ci-kubeconfig" \
    "$RUNNER_TEMP/gost-ci.log" "$RUNNER_TEMP/deployments.json" \
    "$RUNNER_TEMP/pods.json" "$RUNNER_TEMP/overlay.yaml" \
    "$RUNNER_TEMP/cluster-context" "$RUNNER_TEMP/gitops-revision" \
    "$RUNNER_TEMP/deployment-attestation.json" \
    "$RUNNER_TEMP/deployment-attestation.json.remote.tmp"
  rm -rf -- "$RUNNER_TEMP/provenance"
  ((state == 0)) || return 1
  echo 'DEPLOY_IDENTITY_CLEANUP_V1 status=success owned_pid=stopped alias=removed scope=job'
}
start() {
  [[ -n "${GOST_RELAY_URL:-}" && -x "$GOST_BIN" ]] ||
    { fail 'trusted relay or GOST executable unavailable'; return 1; }
  [[ ! -e "$RUNNER_TEMP/gost-ci.pid" && ! -e "$RUNNER_TEMP/gost-ci-alias-owned" ]] ||
    { fail 'stale job-owned network state exists; cleanup required'; return 1; }
  if alias_present; then
    fail 'API alias already exists; refusing to borrow or remove unowned state'
    return 1
  fi
  sudo ip addr add "$API_ALIAS/32" dev lo
  : > "$RUNNER_TEMP/gost-ci-alias-owned"
  # Port 6443 is unprivileged; no sudo wrapper or daemonization between
  # the tracked shell child PID and the GOST binary.
  nohup "$GOST_BIN" -L "$LISTENER" -F "$GOST_RELAY_URL" \
    > "$RUNNER_TEMP/gost-ci.log" 2>&1 &
  local pid="$!" born="" i
  for i in {1..10}; do
    born="$(ticks "$pid" || true)"
    [[ "$born" =~ ^[1-9][0-9]*$ ]] && break
    sleep 0.1
  done
  [[ "$born" =~ ^[1-9][0-9]*$ ]] ||
    { fail 'could not pin the owned GOST process identity'; return 1; }
  printf '%s %s\\n' "$pid" "$born" > "$RUNNER_TEMP/gost-ci.pid"
  for i in {1..15}; do
    if curl -ksS --max-time 2 --output /dev/null \
      "https://${API_ALIAS}:${API_PORT}/healthz" 2>/dev/null; then
      # This probes only loopback, never an unauthorized private LAN target.
      if timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/6443' \
          >/dev/null 2>&1; then
        fail 'listener accepts an unallowlisted local destination'
        return 1
      fi
      echo 'DEPLOY_IDENTITY_TUNNEL_V1 status=ready endpoint=api-only off_alias=denied'
      return 0
    fi
    sleep 2
  done
  fail 'approved Kubernetes API tunnel unavailable (relay log suppressed)'
}

self_test() {
  local temp owned unrelated exe born rc=0
  temp="$(mktemp -d)"
  RUNNER_TEMP="$temp"
  trap 'kill "${owned:-}" "${unrelated:-}" 2>/dev/null || true; rm -rf -- "$temp"' EXIT
  exe="$(readlink -f "$(command -v sleep)")"
  sleep 20 & owned=$!
  sleep 20 & unrelated=$!
  born="$(ticks "$owned")"
  printf '%s %s\\n' "$owned" "$born" > "$temp/gost-ci.pid"
  owned_process "$owned" "$born" "$exe" 'sleep 20'
  # A copied marker with the wrong process birth time must not kill anything.
  printf '%s %s\\n' "$unrelated" "$(( $(ticks "$unrelated") + 1 ))" > "$temp/forged.pid"
  stop_owned_pid "$temp/forged.pid" "$exe" 'sleep 20'
  kill -0 "$unrelated"
  stop_owned_pid "$temp/gost-ci.pid" "$exe" 'sleep 20'
  ! owned_process "$owned" "$born" "$exe" 'sleep 20'
  stop_owned_pid "$temp/gost-ci.pid" "$exe" 'sleep 20' # idempotent
  kill -0 "$unrelated" # never touch unowned processes
  printf '%s' 'malformed' > "$temp/gost-ci.pid"
  if stop_owned_pid "$temp/gost-ci.pid" "$exe" 'sleep 20' 2>/dev/null; then
    fail 'forged PID marker must fail closed'; return 1
  fi
  kill -0 "$unrelated"
  # Stub privileged ip to prove ownership-marker-scoped cleanup.
  local fake_alias=1 deletes=0
  sudo() {
    if [[ "$*" == 'ip -o -4 addr show dev lo' ]]; then
      ((fake_alias)) && echo '1: lo inet 192.168.2.162/32 scope host lo'
    elif [[ "$*" == 'ip addr del 192.168.2.162/32 dev lo' ]]; then
      ((deletes+=1)); fake_alias=0
    else
      fail 'unexpected privileged self-test command'
    fi
  }
  cleanup_alias # no marker, must not remove a pre-existing alias
  [[ "$deletes" == 0 ]]
  : > "$temp/gost-ci-alias-owned"
  cleanup_alias
  cleanup_alias
  [[ "$deletes" == 1 && ! -e "$temp/gost-ci-alias-owned" ]]
  : > "$temp/nession-ci-kubeconfig"
  : > "$temp/foreign-owned-file"
  cleanup
  [[ ! -e "$temp/nession-ci-kubeconfig" && -e "$temp/foreign-owned-file" ]]
  kill -0 "$unrelated"
  kill "$unrelated" 2>/dev/null || true
  echo 'Deploy / Identity tunnel: live child TERM, forged/replayed PID, alias ownership, scoped cleanup and idempotency passed'
}

[[ "${1:-}" == 'self-test' ]] || [[ -n "${RUNNER_TEMP:-}" ]] ||
  { fail 'RUNNER_TEMP is required'; exit 1; }
case "${1:-}" in
  start)
    # This process owns only startup; the workflow's always() cleanup owns
    # shutdown across subsequent Actions steps. A failed start self-cleans.
    trap 'cleanup' EXIT
    start
    trap - EXIT
    ;;
  cleanup) cleanup ;;
  self-test) self_test ;;
  *) fail 'usage: deploy-identity-tunnel.sh <start|cleanup|self-test>'; exit 1 ;;
esac
