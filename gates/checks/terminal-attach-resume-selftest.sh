#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='terminal-attach-resume-selftest'
GATE_NAME='terminal attach resume selftest'
GATE_COMMAND='node e2e/scenarios/terminal-attach-resume/reproduce.cjs --self-test'
GATE_SUCCESS='canonical terminal-attach-resume-selftest contract passes its checks'
GATE_FAILURE='canonical terminal-attach-resume-selftest invariant or fixture failed'
GATE_REPAIR='fix e2e/scenarios/terminal-attach-resume/reproduce.cjs and its fixtures; do not bypass the detection'
GATE_OWNER='e2e/scenarios/terminal-attach-resume/reproduce.cjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/scenarios/terminal-attach-resume/reproduce.cjs' "Restore e2e/scenarios/terminal-attach-resume/reproduce.cjs." || return $?
  gate_run_invariant node e2e/scenarios/terminal-attach-resume/reproduce.cjs --self-test
}
gate_main "$@"
