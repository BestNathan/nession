#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-full-stack-runtime-selftest'
GATE_NAME='e2e full stack runtime selftest'
GATE_COMMAND='node e2e/runner/runtime/full-stack.js self-test'
GATE_SUCCESS='canonical e2e-full-stack-runtime-selftest contract passes its checks'
GATE_FAILURE='canonical e2e-full-stack-runtime-selftest invariant or fixture failed'
GATE_REPAIR='fix e2e/runner/runtime/full-stack.js and its fixtures; do not bypass the detection'
GATE_OWNER='e2e/runner/runtime/full-stack.js'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/runner/runtime/full-stack.js' "Restore e2e/runner/runtime/full-stack.js." || return $?
  gate_run_invariant node e2e/runner/runtime/full-stack.js self-test
}
gate_main "$@"
