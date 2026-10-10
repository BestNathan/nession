#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-browser-report-selftest'
GATE_NAME='e2e browser report selftest'
GATE_COMMAND='node e2e/runner/drivers/browser-report.mjs self-test'
GATE_SUCCESS='canonical e2e-browser-report-selftest contract passes its checks'
GATE_FAILURE='canonical e2e-browser-report-selftest invariant or fixture failed'
GATE_REPAIR='fix e2e/runner/drivers/browser-report.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='e2e/runner/drivers/browser-report.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/runner/drivers/browser-report.mjs' "Restore e2e/runner/drivers/browser-report.mjs." || return $?
  gate_run_invariant node e2e/runner/drivers/browser-report.mjs self-test
}
gate_main "$@"
