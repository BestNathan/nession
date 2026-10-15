#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='run-store-integrity'
GATE_NAME='Run Store immutable Git history and staged delta integrity'
GATE_COMMAND='node scripts/run-store-integrity-selftest.mjs && node scripts/audit-live-run-stores-selftest.mjs && node scripts/run-store-audit-runbook-selftest.mjs && node scripts/run-store-cas-push-selftest.mjs && node scripts/run-store-receipt-verify-selftest.mjs'
GATE_SUCCESS='run-store history/CAS and read-only receipt Git-byte binding tampering fixtures pass'
GATE_FAILURE='a fast-forward rewrite, record deletion, unclassified change or anchor violation was accepted'
GATE_REPAIR='repair scripts/run-store-integrity.mjs without relaxing immutable Run Records'
GATE_OWNER='scripts/run-store-integrity.mjs'
gate_check() {
  gate_require_command git "Install Git to validate Run Store ancestry." || return $?
  gate_require_command node "Install Node.js to run Git integrity fixtures." || return $?
  gate_run_invariant node scripts/run-store-integrity-selftest.mjs && node scripts/audit-live-run-stores-selftest.mjs && node scripts/run-store-audit-runbook-selftest.mjs && node scripts/run-store-cas-push-selftest.mjs && node scripts/run-store-receipt-verify-selftest.mjs
}
gate_main "$@"
