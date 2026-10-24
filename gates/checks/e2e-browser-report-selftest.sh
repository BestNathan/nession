#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-browser-report-selftest'
GATE_NAME='e2e browser report selftest'
GATE_COMMAND='Full E2E report, failure intake and main release receipt policy self-tests'
GATE_SUCCESS='canonical e2e-browser-report-selftest contract passes its checks'
GATE_FAILURE='canonical e2e-browser-report-selftest invariant or fixture failed'
GATE_REPAIR='fix canonical E2E report/receipt policy owners and negative fixtures; never bypass Full release proof'
GATE_OWNER='e2e/runner/drivers/browser-report.mjs + scripts/main-full-release-gate.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './e2e/runner/drivers/browser-report.mjs' "Restore e2e/runner/drivers/browser-report.mjs." || return $?
  gate_run_invariant node e2e/runner/drivers/browser-report.mjs self-test
  gate_run_invariant node scripts/e2e-full-failure-manifest.mjs self-test
  gate_require_path './scripts/main-full-release-gate.mjs' 'Restore Main Full release verification policy.' || return $?
  gate_run_invariant node scripts/main-full-release-gate.mjs self-test
  gate_run_invariant node scripts/e2e-failure-intake-contract.mjs self-test
  gate_run_invariant node scripts/e2e-full-failure-ingest.mjs self-test
  gate_run_invariant node scripts/lib/agent/orchestration/e2e-failure-ledger.mjs self-test
  gate_run_invariant node scripts/e2e-failure-admission-ingest.mjs self-test
}
gate_main "$@"
