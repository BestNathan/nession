#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-playwright'
GATE_NAME='End-to-end browser tests'
GATE_COMMAND='cd e2e && CI=true npx playwright test'
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
  if (cd e2e && CI=true npx playwright test); then
    return 0
  fi
  gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
}

gate_main "$@"
