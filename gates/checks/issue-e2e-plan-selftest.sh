#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-e2e-plan-selftest'
GATE_NAME='Issue E2E selection plan contract'
GATE_COMMAND='node scripts/issue-e2e-plan.mjs self-test'
GATE_SUCCESS='the deterministic E2E contract and negative fixtures pass'
GATE_FAILURE='the selected E2E contract has invalid or falsely accepted inputs'
GATE_REPAIR='repair the canonical source script; do not bypass negative fixtures'
GATE_OWNER='scripts/issue-e2e-plan.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the E2E contract Gate." || return $?
  gate_run_invariant node scripts/issue-e2e-plan.mjs self-test
}

gate_main "$@"
