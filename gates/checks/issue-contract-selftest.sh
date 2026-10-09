#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-contract-selftest'
GATE_NAME='Issue contract validator contract'
GATE_COMMAND='node scripts/issue-contract.mjs self-test'
GATE_SUCCESS='issue contract validator self-tests pass'
GATE_FAILURE='issue contract parsing/validation failed its deterministic fixtures'
GATE_REPAIR='fix the issue contract validator or fixture without weakening the requirement format'
GATE_OWNER='scripts/issue-contract.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/issue-contract.mjs self-test
}

gate_main "$@"
