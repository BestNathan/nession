#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='test-isolation-selftest'
GATE_NAME='Test-isolation checker contract'
GATE_COMMAND='./scripts/check-test-isolation-selftest.sh'
GATE_SUCCESS='the test-isolation checker detects all known violation fixtures'
GATE_FAILURE='the test-isolation checker stopped catching a violation it claims to prevent'
GATE_REPAIR='fix the checker or fixture without weakening the isolation rule'
GATE_OWNER='scripts/check-test-isolation.sh + scripts/check-test-isolation-selftest.sh'

gate_check() {
  gate_require_path './scripts/check-test-isolation-selftest.sh' 'Restore ./scripts/check-test-isolation-selftest.sh.' || return $?
  gate_run_invariant ./scripts/check-test-isolation-selftest.sh
}

gate_main "$@"
