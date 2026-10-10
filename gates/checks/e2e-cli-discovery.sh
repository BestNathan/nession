#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-cli-discovery'
GATE_NAME='e2e cli discovery'
GATE_COMMAND='./e2e/run --list'
GATE_SUCCESS='canonical e2e-cli-discovery contract passes its checks'
GATE_FAILURE='canonical e2e-cli-discovery invariant or fixture failed'
GATE_REPAIR='fix e2e/run and its fixtures; do not bypass the detection'
GATE_OWNER='e2e/run'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/run' "Restore e2e/run." || return $?
  gate_run_invariant ./e2e/run --list
}
gate_main "$@"
