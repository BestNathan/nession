#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acceptance-runtime-contract'
GATE_NAME='Acceptance full-stack runtime contract'
GATE_COMMAND='./e2e/run --validate'
GATE_SUCCESS='E2E runtime/Case discovery and CLI contracts validate'
GATE_FAILURE='the Acceptance full-stack runtime contract is inconsistent'
GATE_REPAIR='repair e2e/runner or the canonical CLI rather than skipping its validation'
GATE_OWNER='e2e/run + e2e/runner'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_path './e2e/run' 'Restore e2e/run.' || return $?
  gate_run_invariant ./e2e/run --validate
}

gate_main "$@"
