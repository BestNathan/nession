#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-event-publisher-selftest'
GATE_NAME='Exact-run durable Acceptance outbox publisher'
GATE_COMMAND='node scripts/acceptance-event-publisher-selftest.mjs'
GATE_SUCCESS='2026 dispatch run receipts, exact task identity, bounded 429 retry, uncertain reconciliation and SQLite restart verified'
GATE_FAILURE='unattested POST, ambiguous replay, forged run receipt or unsafe crash/quota retry'
GATE_REPAIR='repair scripts/acceptance-event-publisher.mjs and publisher self-test; preserve existing Waker/Quota fallback'
GATE_OWNER='scripts/acceptance-event-publisher.mjs'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-event-publisher-selftest.mjs' "Restore publisher fixtures." || return $?
  gate_run_invariant node scripts/acceptance-event-publisher-selftest.mjs
}
gate_main "$@"
