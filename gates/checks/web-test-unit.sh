#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='web-test-unit'
GATE_NAME='Web unit tests'
GATE_COMMAND='./scripts/filtered-web-test.sh --project unit'
GATE_SUCCESS='all Web unit tests pass'
GATE_FAILURE='a Web unit test failed'
GATE_REPAIR='fix the failing unit behavior/test and rerun this gate'
GATE_OWNER='scripts/filtered-web-test.sh + web/vite.config.ts'

gate_check() {
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  gate_run_invariant ./scripts/filtered-web-test.sh --project unit
}

gate_main "$@"
