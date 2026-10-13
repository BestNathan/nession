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
  local selected_report="${RUNNER_TEMP:-/tmp}/e2e-playwright-selected-${GITHUB_RUN_ID:-local}.json"
  # Playwright list-only discovery has no full-stack startup; verify it matches file-ID catalog.
  gate_run_invariant bash -c 'cd e2e && npx playwright test --list > "$1"' _ "$list_file"
  gate_run_invariant node e2e/runner/verify-playwright-list.cjs "$list_file"
  # One two-ID canary: prove precise selection and independently attributable real outcomes.
  # Once #1702 owns PR selection this transitional extra run can be retired.
  gate_run_invariant bash -c 'cd e2e && CI=true PLAYWRIGHT_JSON_OUTPUT_FILE="$1" ./run test --id login --id session-lifecycle' _ "$selected_report"
  gate_run_invariant node e2e/runner/verify-playwright-selected.cjs "$selected_report" login session-lifecycle
  gate_run_invariant bash -c 'cd e2e && CI=true ./run test --all'
}

gate_main "$@"
