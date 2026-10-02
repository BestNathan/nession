#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='web-typecheck'
GATE_NAME='Web TypeScript'
GATE_COMMAND='cd web && npx tsc --noEmit'
GATE_SUCCESS='the Web TypeScript program type-checks with zero errors'
GATE_FAILURE='TypeScript reported one or more type errors'
GATE_REPAIR='fix the type/contract at its owner and rerun the gate'
GATE_OWNER='web/tsconfig.json + Web TypeScript source'

gate_check() {
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  if (cd web && npx tsc --noEmit); then
    return 0
  fi
  gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
}

gate_main "$@"
