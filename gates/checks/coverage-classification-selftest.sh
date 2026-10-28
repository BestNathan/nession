#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='coverage-classification-selftest'
GATE_NAME='coverage gate failure classification'
GATE_COMMAND='./scripts/check-coverage-selftest.sh'
GATE_SUCCESS='the coverage gate distinguishes a failed test run from a missing llvm-cov'
GATE_FAILURE='the coverage gate stopped classifying its no-JSON boundary'
GATE_REPAIR='fix scripts/check-coverage.sh and its selftest; do not restore the generic install hint'
GATE_OWNER='scripts/check-coverage.sh + scripts/check-coverage-selftest.sh'

gate_check() {
  gate_require_path './scripts/check-coverage-selftest.sh' 'Restore ./scripts/check-coverage-selftest.sh.' || return $?
  gate_run_invariant ./scripts/check-coverage-selftest.sh
}

gate_main "$@"
