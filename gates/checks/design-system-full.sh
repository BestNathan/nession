#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='design-system-full'
GATE_NAME='Design system (full)'
GATE_COMMAND='node design/scripts/design-gate.mjs --profile full'
GATE_SUCCESS='the canonical design-system full profile passes'
GATE_FAILURE='one or more canonical design-system full profile rules failed'
GATE_REPAIR='follow the design gate owner/repair diagnostics; fix the canonical design source or consumer instead of bypassing the rule'
GATE_OWNER='design/scripts/design-gate.mjs + canonical design sources'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  gate_run_invariant node design/scripts/design-gate.mjs --profile full
}

gate_main "$@"
