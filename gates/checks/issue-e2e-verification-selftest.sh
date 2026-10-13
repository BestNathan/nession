#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='issue-e2e-verification-selftest'
GATE_NAME='Issue E2E trusted verification contracts'
GATE_COMMAND='node scripts/issue-e2e-selection-entry.mjs self-test && node scripts/issue-e2e-collect.mjs self-test && node scripts/issue-e2e-source-attestation.mjs self-test && node scripts/issue-e2e-gate.mjs self-test'
GATE_SUCCESS='planning, collection, source authentication and exact-SHA proof checks pass'
GATE_FAILURE='Issue E2E provenance or gating invariant cannot be verified'
GATE_REPAIR='repair the owning Issue E2E scripts and negative fixtures'
GATE_OWNER='scripts/issue-e2e-gate.mjs'
gate_check() {
  gate_require_command node "Install Node.js and rerun verification Gate." || return $?
  gate_run_invariant bash -c 'node scripts/issue-e2e-selection-entry.mjs self-test && node scripts/issue-e2e-collect.mjs self-test && node scripts/issue-e2e-source-attestation.mjs self-test && node scripts/issue-e2e-gate.mjs self-test'
}
gate_main "$@"
