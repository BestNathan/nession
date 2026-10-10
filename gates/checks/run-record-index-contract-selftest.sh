#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='run-record-index-contract-selftest'
GATE_NAME='run record index contract selftest'
GATE_COMMAND='node scripts/run-record-index-contract.mjs self-test'
GATE_SUCCESS='canonical run-record-index-contract-selftest contract passes its checks'
GATE_FAILURE='canonical run-record-index-contract-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/run-record-index-contract.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/run-record-index-contract.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/run-record-index-contract.mjs' "Restore scripts/run-record-index-contract.mjs." || return $?
  gate_run_invariant node scripts/run-record-index-contract.mjs self-test
}
gate_main "$@"
