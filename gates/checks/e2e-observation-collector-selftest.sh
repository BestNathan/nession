#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-observation-collector-selftest'
GATE_NAME='e2e observation collector selftest'
GATE_COMMAND='node e2e/runner/collectors/opt-in-observations.cjs self-test'
GATE_SUCCESS='canonical e2e-observation-collector-selftest contract passes its checks'
GATE_FAILURE='canonical e2e-observation-collector-selftest invariant or fixture failed'
GATE_REPAIR='fix e2e/runner/collectors/opt-in-observations.cjs and its fixtures; do not bypass the detection'
GATE_OWNER='e2e/runner/collectors/opt-in-observations.cjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/runner/collectors/opt-in-observations.cjs' "Restore e2e/runner/collectors/opt-in-observations.cjs." || return $?
  gate_run_invariant node e2e/runner/collectors/opt-in-observations.cjs self-test
}
gate_main "$@"
