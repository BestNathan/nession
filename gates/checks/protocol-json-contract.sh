#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='protocol-json-contract'
GATE_NAME='protocol json contract'
GATE_COMMAND='node scripts/protocol-gate.mjs --json >/dev/null'
GATE_SUCCESS='canonical protocol-json-contract contract passes its checks'
GATE_FAILURE='canonical protocol-json-contract invariant or fixture failed'
GATE_REPAIR='fix scripts/protocol-gate.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/protocol-gate.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/protocol-gate.mjs' "Restore scripts/protocol-gate.mjs." || return $?
  gate_run_invariant bash -c 'node scripts/protocol-gate.mjs --json >/dev/null'
}
gate_main "$@"
