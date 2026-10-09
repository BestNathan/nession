#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='protocol-integrity-selftest'
GATE_NAME='Protocol integrity checker contract'
GATE_COMMAND='./scripts/protocol-gate-selftest.sh'
GATE_SUCCESS='the protocol checker rejects every known protocol violation fixture'
GATE_FAILURE='the protocol checker stopped catching a rule it claims to enforce'
GATE_REPAIR='fix scripts/protocol-gate.mjs/selftest; do not weaken the protocol invariant'
GATE_OWNER='scripts/protocol-gate.mjs + scripts/protocol-gate-selftest.sh'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant ./scripts/protocol-gate-selftest.sh
}

gate_main "$@"
