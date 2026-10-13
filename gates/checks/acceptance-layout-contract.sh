#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acceptance-layout-contract'
GATE_NAME='Canonical Acceptance source layout'
GATE_COMMAND='node scripts/acceptance-layout-contract.mjs self-test && node scripts/acceptance-layout-contract.mjs check'
GATE_SUCCESS='Root acceptance aliases absent; only canonical Case contract and shared verifier paths used'
GATE_FAILURE='Legacy Acceptance source or executable import returned'
GATE_REPAIR='move the code to e2e/acceptance and update consumers; do not add a fallback'
GATE_OWNER='scripts/acceptance-layout-contract.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant bash -c 'node scripts/acceptance-layout-contract.mjs self-test && node scripts/acceptance-layout-contract.mjs check'
}

gate_main "$@"
