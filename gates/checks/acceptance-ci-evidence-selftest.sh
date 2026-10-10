#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-ci-evidence-selftest'
GATE_NAME='acceptance ci evidence selftest'
GATE_COMMAND='node scripts/acceptance-ci-evidence.mjs self-test'
GATE_SUCCESS='canonical acceptance-ci-evidence-selftest contract passes its checks'
GATE_FAILURE='canonical acceptance-ci-evidence-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/acceptance-ci-evidence.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/acceptance-ci-evidence.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/acceptance-ci-evidence.mjs' "Restore scripts/acceptance-ci-evidence.mjs." || return $?
  gate_run_invariant node scripts/acceptance-ci-evidence.mjs self-test
}
gate_main "$@"
