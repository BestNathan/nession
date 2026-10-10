#!/usr/bin/env bash
set -euo pipefail

GATE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE_REPO_ROOT="$(cd "${GATE_LIB_DIR}/../.." && pwd -P)"
readonly GATE_LIB_DIR GATE_REPO_ROOT

GATE_RUNTIME_REASON=""
GATE_RUNTIME_REPAIR=""

_gate_contract_error() {
  GATE_RUNTIME_REASON="$1"
  GATE_RUNTIME_REPAIR="Fix the gate declaration before running it again."
  return 2
}

gate_contract_validate() {
  local field value
  for field in GATE_ID GATE_NAME GATE_COMMAND GATE_SUCCESS GATE_FAILURE GATE_REPAIR GATE_OWNER; do
    case "$field" in
      GATE_ID) value="${GATE_ID-}" ;;
      GATE_NAME) value="${GATE_NAME-}" ;;
      GATE_COMMAND) value="${GATE_COMMAND-}" ;;
      GATE_SUCCESS) value="${GATE_SUCCESS-}" ;;
      GATE_FAILURE) value="${GATE_FAILURE-}" ;;
      GATE_REPAIR) value="${GATE_REPAIR-}" ;;
      GATE_OWNER) value="${GATE_OWNER-}" ;;
    esac
    if [ -z "$value" ]; then
      _gate_contract_error "missing required gate metadata: ${field}"
      return 2
    fi
  done
  if ! [[ "$GATE_ID" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    _gate_contract_error "GATE_ID must be kebab-case: ${GATE_ID}"
    return 2
  fi
  if ! declare -F gate_check >/dev/null 2>&1; then
    _gate_contract_error "gate_check function is not defined"
    return 2
  fi
}

gate_describe() {
  printf 'id: %s\n' "$GATE_ID"
  printf 'name: %s\n' "$GATE_NAME"
  printf 'command: %s\n' "$GATE_COMMAND"
  printf 'success: %s\n' "$GATE_SUCCESS"
  printf 'failure: %s\n' "$GATE_FAILURE"
  printf 'repair: %s\n' "$GATE_REPAIR"
  printf 'owner: %s\n' "$GATE_OWNER"
}

gate_invariant_failure() {
  GATE_RUNTIME_REASON="$1"
  GATE_RUNTIME_REPAIR="${2:-$GATE_REPAIR}"
  return 1
}

gate_runtime_error() {
  GATE_RUNTIME_REASON="$1"
  GATE_RUNTIME_REPAIR="${2:-$GATE_REPAIR}"
  return 2
}

gate_require_command() {
  local command_name="$1"
  local repair="${2:-Install '${command_name}' and rerun the gate.}"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    gate_runtime_error "required command '${command_name}' is unavailable" "$repair"
    return 2
  fi
}

gate_require_path() {
  local path="$1"
  local repair="${2:-Restore '${path}' and rerun the gate.}"
  if [ ! -e "$path" ]; then
    gate_runtime_error "required path '${path}' is unavailable" "$repair"
    return 2
  fi
}

gate_require_env() {
  local name="$1"
  local repair="${2:-Provide '${name}' and rerun the gate.}"
  local value=""
  value="$(printenv "$name" 2>/dev/null || true)"
  if [ -z "$value" ]; then
    gate_runtime_error "required environment variable '${name}' is unavailable" "$repair"
    return 2
  fi
}

# Exit 1 is the conventional invariant-failed result. Cargo tests use 101 for
# failed assertions. Other statuses (including 2, 126 and 127) mean the
# command could not prove its invariant and must not be reported as a FAIL.
# Adapters with different documented exit semantics must classify explicitly.
gate_run_invariant() {
  local status=0
  if "$@"; then
    return 0
  else
    status=$?
  fi
  case "$status" in
    1|101)
      gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
      ;;
    *)
      gate_runtime_error "gate command exited with status ${status}; the invariant could not be proven" \
        "repair the command/tooling failure shown in output, then rerun the exact gate"
      ;;
  esac
}

_gate_print_detail() {
  local kind="$1"
  local reason="$2"
  local repair="$3"
  local output_file="$4"
  printf '[%s] %s\n' "$kind" "$GATE_ID" >&2
  printf 'name: %s\n' "$GATE_NAME" >&2
  printf 'reason: %s\n' "$reason" >&2
  printf 'repair: %s\n' "$repair" >&2
  printf 'command: %s\n' "$GATE_COMMAND" >&2
  printf 'owner: %s\n' "$GATE_OWNER" >&2
  if [ -s "$output_file" ]; then
    printf 'output:\n' >&2
    sed 's/^/  /' "$output_file" >&2
  fi
}

gate_main() {
  local status=0
  local output_file=""
  local caller_cwd="$PWD"
  GATE_RUNTIME_REASON=""
  GATE_RUNTIME_REPAIR=""

  if gate_contract_validate; then
    :
  else
    status=$?
    printf '[ERROR] %s\n' "${GATE_ID:-unknown}" >&2
    printf 'reason: %s\n' "${GATE_RUNTIME_REASON:-invalid gate contract}" >&2
    printf 'repair: %s\n' "${GATE_RUNTIME_REPAIR:-fix the gate declaration and rerun}" >&2
    return "$status"
  fi

  case "${1:-}" in
    --describe)
      gate_describe
      return 0
      ;;
    --help)
      printf 'usage: %s [--describe] [gate-specific arguments...]\n\n' "$0"
      gate_describe
      return 0
      ;;
  esac

  output_file="$(mktemp "${TMPDIR:-/tmp}/nession-gate-${GATE_ID}.XXXXXX")"
  cd "$GATE_REPO_ROOT"
  set +e
  gate_check "$@" >"$output_file" 2>&1
  status=$?
  set -e
  cd "$caller_cwd"

  case "$status" in
    0)
      rm -f "$output_file"
      printf '✓ %s\n' "$GATE_ID"
      return 0
      ;;
    1)
      _gate_print_detail "FAIL" "${GATE_RUNTIME_REASON:-$GATE_FAILURE}" "${GATE_RUNTIME_REPAIR:-$GATE_REPAIR}" "$output_file"
      rm -f "$output_file"
      return 1
      ;;
    *)
      _gate_print_detail "ERROR" \
        "${GATE_RUNTIME_REASON:-gate command exited with status ${status}; the invariant could not be proven}" \
        "${GATE_RUNTIME_REPAIR:-restore the gate tooling/environment, then rerun the exact command above}" \
        "$output_file"
      rm -f "$output_file"
      return 2
      ;;
  esac
}
