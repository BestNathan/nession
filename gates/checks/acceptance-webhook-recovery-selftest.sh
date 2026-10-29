#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-webhook-recovery-selftest'
GATE_NAME='GitHub App missed webhook durable recovery'
GATE_COMMAND='node scripts/acceptance-webhook-recovery-selftest.mjs'
GATE_SUCCESS='scoped App JWT deliveries, GUID dedupe, three-day retention, restart and timeout backoff fixtures pass'
GATE_FAILURE='failed App webhook may be lost or a recovery scanner can redeliver forged/duplicate events'
GATE_REPAIR='repair scripts/acceptance-webhook-recovery.mjs, bounded pagination or SQLite reservations'
GATE_OWNER='scripts/acceptance-webhook-recovery.mjs'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-webhook-recovery-selftest.mjs' "Restore webhook failure fixtures." || return $?
  gate_run_invariant node scripts/acceptance-webhook-recovery-selftest.mjs
}
gate_main "$@"
