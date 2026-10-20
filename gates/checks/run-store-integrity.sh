#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='run-store-integrity'
GATE_NAME='Run Store immutable Git history and staged delta integrity'
GATE_COMMAND='node scripts/run-store-governance-live.mjs self-test && node scripts/run-store-integrity-selftest.mjs && node scripts/audit-live-run-stores-selftest.mjs && node scripts/run-store-audit-runbook-selftest.mjs && node scripts/run-store-cas-push-selftest.mjs && node scripts/run-store-receipt-verify-selftest.mjs && node scripts/run-store-receipt-live-selftest.mjs && node scripts/run-store-agent-disposable-selftest.mjs && node scripts/run-store-fixture-evidence-selftest.mjs && node scripts/run-store-cas-matrix.mjs self-test && node scripts/run-store-integrity-drill.mjs self-test && node scripts/run-store-five-mode-evidence.mjs self-test && node scripts/e2e-push-evidence-concurrency-selftest.mjs'
GATE_SUCCESS='Run Store CAS concurrency/replay/collision, immutable history, receipt binding and disposable agent-store fixtures pass'
GATE_FAILURE='a fast-forward rewrite, record deletion, unclassified change or anchor violation was accepted'
GATE_REPAIR='repair scripts/run-store-integrity.mjs without relaxing immutable Run Records'
GATE_OWNER='scripts/run-store-integrity.mjs'
gate_check() {
  gate_require_command git "Install Git to validate Run Store ancestry." || return $?
  gate_require_command node "Install Node.js to run Git integrity fixtures." || return $?
  gate_run_invariant node scripts/run-store-governance-live.mjs self-test && node scripts/run-store-integrity-selftest.mjs && node scripts/audit-live-run-stores-selftest.mjs && node scripts/run-store-audit-runbook-selftest.mjs && node scripts/run-store-cas-push-selftest.mjs && node scripts/run-store-receipt-verify-selftest.mjs && node scripts/run-store-receipt-live-selftest.mjs && node scripts/run-store-agent-disposable-selftest.mjs && node scripts/run-store-fixture-evidence-selftest.mjs && node scripts/run-store-cas-matrix.mjs self-test && node scripts/run-store-integrity-drill.mjs self-test && node scripts/run-store-five-mode-evidence.mjs self-test && node scripts/e2e-push-evidence-concurrency-selftest.mjs
}
gate_main "$@"
