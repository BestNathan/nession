#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='issue-e2e-contract-selftest'
GATE_NAME='Issue New and Regression E2E contract'
GATE_COMMAND='node scripts/issue-e2e-contract.mjs self-test'
GATE_SUCCESS='Issue E2E contract rejects invalid, missing and stale declarations'
GATE_FAILURE='invalid Issue E2E declaration can bypass required regression proof'
GATE_REPAIR='repair scripts/issue-e2e-contract.mjs and add positive and negative fixtures'
GATE_OWNER='scripts/issue-e2e-contract.mjs'
gate_check() {
  gate_require_command node "Install Node.js and rerun the Issue E2E contract Gate." || return $?
  gate_run_invariant node scripts/issue-e2e-contract.mjs self-test
}
gate_main "$@"
