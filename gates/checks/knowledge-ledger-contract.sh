#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='knowledge-ledger-contract'
GATE_NAME='Knowledge ledger schema and immutable-history detector'
GATE_COMMAND='node scripts/knowledge-ledger-contract.mjs self-test'
GATE_SUCCESS='knowledge revisions, event history, CAS delta and digests pass positive/negative fixtures'
GATE_FAILURE='knowledge record/schema/history contract failed'
GATE_REPAIR='repair the canonical knowledge-ledger-contract.mjs rules and negative fixtures'
GATE_OWNER='scripts/knowledge-ledger-contract.mjs + docs/engineering/knowledge-ledger.md'
gate_check() {
  gate_require_command node "Install Node.js to verify the ledger." || return $?
  gate_require_command git "Install Git for the history mutation fixtures." || return $?
  gate_run_invariant node scripts/knowledge-ledger-contract.mjs self-test
}
gate_main "$@"
