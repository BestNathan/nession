#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='web-eslint'
GATE_NAME='Web ESLint'
GATE_COMMAND='cd web && npx eslint . --report-unused-disable-directives --max-warnings 0'
GATE_SUCCESS='all Web source passes ESLint with zero warnings'
GATE_FAILURE='ESLint reported a Web source violation'
GATE_REPAIR='fix the reported source/configuration issue; do not suppress a rule just to make the gate green'
GATE_OWNER='web/eslint.config.js + web/eslint-plugin-nession/'

gate_check() {
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  if (cd web && npx eslint . --report-unused-disable-directives --max-warnings 0); then
    return 0
  fi
  gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
}

gate_main "$@"
