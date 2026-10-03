#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='design-system-browser'
GATE_NAME='Design system (browser)'
GATE_COMMAND='node design/scripts/design-gate.mjs --profile browser'
GATE_SUCCESS='the canonical design-system browser profile passes'
GATE_FAILURE='one or more canonical design-system browser profile rules failed'
GATE_REPAIR='follow the design gate owner/repair diagnostics; fix the canonical design source or consumer instead of bypassing the rule'
GATE_OWNER='design/scripts/design-gate.mjs + canonical design sources'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./e2e/node_modules" "Run `cd e2e && npm install` before this gate." || return $?
  gate_run_invariant node design/scripts/design-gate.mjs --profile browser
}

gate_main "$@"
