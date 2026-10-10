#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='run-record-artifact-evidence-selftest'
GATE_NAME='run record artifact evidence selftest'
GATE_COMMAND='node scripts/run-record-artifact-evidence.mjs self-test'
GATE_SUCCESS='canonical run-record-artifact-evidence-selftest contract passes its checks'
GATE_FAILURE='canonical run-record-artifact-evidence-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/run-record-artifact-evidence.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/run-record-artifact-evidence.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/run-record-artifact-evidence.mjs' "Restore scripts/run-record-artifact-evidence.mjs." || return $?
  gate_run_invariant node scripts/run-record-artifact-evidence.mjs self-test
}
gate_main "$@"
