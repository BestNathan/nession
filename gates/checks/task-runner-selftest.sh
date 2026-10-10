#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='task-runner-selftest'
GATE_NAME='task runner selftest'
GATE_COMMAND='node scripts/task-runner.mjs self-test'
GATE_SUCCESS='canonical task-runner-selftest contract passes its checks'
GATE_FAILURE='canonical task-runner-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/task-runner.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/task-runner.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/task-runner.mjs' "Restore scripts/task-runner.mjs." || return $?
  gate_run_invariant node scripts/task-runner.mjs self-test
}
gate_main "$@"
