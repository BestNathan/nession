#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='trusted-case-discovery-selftest'
GATE_NAME='trusted case discovery selftest'
GATE_COMMAND='node scripts/trusted-case-discovery-selftest.mjs'
GATE_SUCCESS='canonical trusted-case-discovery-selftest contract passes its checks'
GATE_FAILURE='canonical trusted-case-discovery-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/trusted-case-discovery-selftest.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/trusted-case-discovery-selftest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/trusted-case-discovery-selftest.mjs' "Restore scripts/trusted-case-discovery-selftest.mjs." || return $?
  gate_run_invariant node scripts/trusted-case-discovery-selftest.mjs
}
gate_main "$@"
