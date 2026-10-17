#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-playwright'
GATE_NAME='End-to-end browser tests'
GATE_COMMAND='cd e2e && CI=true ./run test --all'
GATE_SUCCESS='the full Nession Playwright E2E suite passes'
GATE_FAILURE='one or more browser E2E scenarios failed'
GATE_REPAIR='inspect e2e/playwright-report and test-results, fix the failing runtime/UI behavior, and rerun the gate'
GATE_OWNER='e2e/ Playwright suite + runtime surfaces'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command tmux "Install tmux; nession-agent requires it for E2E sessions." || return $?
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./e2e/node_modules" "Run `cd e2e && npm install` and install Chromium before this gate." || return $?
  gate_require_path "./web/dist" "Run `cd web && npm run build` before the E2E gate." || return $?
  gate_require_command node "Install Node.js and rerun the E2E gate." || return $?
  gate_require_path "./e2e/run" "Restore the canonical E2E runner." || return $?
  local list_file="${RUNNER_TEMP:-/tmp}/e2e-playwright-list-${GITHUB_RUN_ID:-local}.txt"
  local full_report="${RUNNER_TEMP:-/tmp}/e2e-playwright-full-${GITHUB_RUN_ID:-local}.json"
  local provision_log="${RUNNER_TEMP:-/tmp}/e2e-playwright-provisions-${GITHUB_RUN_ID:-local}.jsonl"
  : > "$provision_log"
  # Playwright list-only discovery has no full-stack startup; verify it matches file-ID catalog.
  gate_run_invariant bash -c 'cd e2e && npx playwright test --list > "$1"' _ "$list_file"
  gate_run_invariant node e2e/runner/verify-playwright-list.cjs "$list_file"
  # #1866 SC-03: this Gate used to provision the real full stack TWICE — a
  # two-ID canary run, then `--all`. Selection is a pure ID -> spec-file
  # mapping, so its positive and negative contract is verified without a
  # runtime, and each canary ID's REAL outcome is verified per ID from the one
  # full run below. The subset runtime path keeps live coverage on every
  # selected PR run, which invokes `./e2e/run test --id …` for real.
  gate_run_invariant node e2e/runner/verify-e2e-selector.cjs login session-lifecycle
  # Exactly one full-stack provision for this Gate invocation. Measured, not
  # assumed: the shared runtime appends one line per real provision.
  gate_run_invariant bash -c 'cd e2e && CI=true E2E_RUNTIME_PROVISION_LOG="$2" PLAYWRIGHT_JSON_OUTPUT_FILE="$1" ./run test --all' _ "$full_report" "$provision_log"
  gate_run_invariant bash -c '
    count=$(wc -l < "$1" | tr -d " ")
    if [ "$count" -ne 1 ]; then
      echo "one Gate invocation must provision the full stack exactly once; observed ${count}" >&2
      exit 1
    fi' _ "$provision_log"
  # Legacy selector/canary assurance retained against that single run: a canary
  # ID that did not run, was skipped, or did not fully pass still fails here.
  gate_run_invariant node e2e/runner/verify-playwright-selected.cjs "$full_report" login session-lifecycle
  # #1866 Measurements: bounded, non-sensitive gate evidence. The Gate's own
  # command output is intentionally discarded on success, so the measured
  # provision count would otherwise be unobservable after the fact.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'e2e-playwright: mode=full full_stack_provisions=%s sha=%s\n' \
      "$(wc -l < "$provision_log" | tr -d ' ')" "${GITHUB_SHA:-unknown}" \
      >> "$GITHUB_STEP_SUMMARY"
  fi
}

gate_main "$@"
