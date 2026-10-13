#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-e2e-obligations-selftest'
GATE_NAME='Issue E2E trusted proof and Agent proposal invariants'
GATE_COMMAND='node scripts/issue-e2e-gate.mjs self-test && node scripts/issue-e2e-proposal.mjs self-test'
GATE_SUCCESS='verified E2E proof rejects foreign SHA/digest; Agent proposals require trusted approval'
GATE_FAILURE='Issue E2E evidence/proposal trust boundary can be bypassed'
GATE_REPAIR='repair scripts/issue-e2e-gate.mjs or scripts/issue-e2e-proposal.mjs'
GATE_OWNER='scripts/issue-e2e-gate.mjs + scripts/issue-e2e-proposal.mjs'

gate_check() {
  gate_require_command node "Install Node.js before running the Issue E2E Gate." || return $?
  gate_run_invariant bash -c 'node scripts/issue-e2e-gate.mjs self-test && node scripts/issue-e2e-proposal.mjs self-test'
}

gate_main "$@"
