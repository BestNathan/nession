#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='test-isolation'
GATE_NAME='Test isolation'
GATE_COMMAND='./scripts/check-test-isolation.sh'
GATE_SUCCESS='tests do not use repository-known shared ports/files/home state'
GATE_FAILURE='a test uses state that can collide with another concurrent test run'
GATE_REPAIR='make the test allocate unique ports/files/state and follow the checker diagnostic'
GATE_OWNER='scripts/check-test-isolation.sh'

gate_check() {
  gate_require_path './scripts/check-test-isolation.sh' 'Restore ./scripts/check-test-isolation.sh.' || return $?
  gate_run_invariant ./scripts/check-test-isolation.sh
}

gate_main "$@"
