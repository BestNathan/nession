#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='issue-e2e-projector-selftest'
GATE_NAME='Trusted Issue E2E result projection contract'
GATE_COMMAND='node scripts/issue-e2e-project.mjs self-test && node scripts/issue-e2e-projection-receipt.mjs self-test'
GATE_SUCCESS='per-Issue results reject missing, stale and untrusted proof'
GATE_FAILURE='Issue E2E results could be forged or silently omitted'
GATE_REPAIR='repair the Issue E2E projection contract and negative tests'
GATE_OWNER='scripts/issue-e2e-project.mjs'
gate_check() {
  gate_require_command node "Install Node.js and rerun Issue E2E projection Gate." || return $?
  gate_run_invariant node scripts/issue-e2e-project.mjs self-test && node scripts/issue-e2e-projection-receipt.mjs self-test
}
gate_main "$@"
