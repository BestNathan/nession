#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-quota-recovery-selftest'
GATE_NAME='Bounded authenticated Acceptance quota recovery'
GATE_COMMAND='node scripts/acceptance-quota-recovery.mjs self-test'
GATE_SUCCESS='trusted recovery rejects stale SHA, wrong attempt, 403/429 and duplicate replay'
GATE_FAILURE='unsafe/uncapped Acceptance recovery or broken negative fixtures'
GATE_REPAIR='repair scripts/acceptance-quota-recovery.mjs without bypassing exact-head CI and E2E'
GATE_OWNER='scripts/acceptance-quota-recovery.mjs'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-quota-recovery.mjs' "Restore canonical quota recovery." || return $?
  gate_run_invariant node scripts/acceptance-quota-recovery.mjs self-test
}
gate_main "$@"
