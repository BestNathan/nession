#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='web-coverage'
GATE_NAME='Web coverage thresholds'
GATE_COMMAND='./scripts/filtered-web-test.sh --coverage'
GATE_SUCCESS='Web tests satisfy the configured Vitest coverage thresholds'
GATE_FAILURE='Web coverage is below one or more configured thresholds or the coverage run failed'
GATE_REPAIR='add tests for uncovered Web behavior and rerun the coverage gate'
GATE_OWNER='scripts/filtered-web-test.sh + web/vite.config.ts'

gate_check() {
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  gate_run_invariant ./scripts/filtered-web-test.sh --coverage
}

gate_main "$@"
