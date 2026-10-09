#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='protocol-integrity'
GATE_NAME='Protocol integrity'
GATE_COMMAND='node scripts/protocol-gate.mjs'
GATE_SUCCESS='all referenced protocol wires have valid producers/consumers and advertised units have callers'
GATE_FAILURE='a protocol wire/unit is malformed, unowned, unanswered, unsent, or otherwise inconsistent'
GATE_REPAIR='fix the canonical protocol owner/call site; do not suppress or shadow the finding'
GATE_OWNER='scripts/protocol-gate.mjs + crates/nession-protocol + protocol consumers'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/protocol-gate.mjs
}

gate_main "$@"
