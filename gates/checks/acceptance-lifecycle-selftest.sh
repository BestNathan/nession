#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-lifecycle-selftest'
GATE_NAME='Issue lifecycle four-state derivation'
GATE_COMMAND='node scripts/acceptance-lifecycle.mjs self-test'
GATE_SUCCESS='Staging Development Complete, Main Promoted, Regression Qualified and Released order fail-closed'
GATE_FAILURE='the lifecycle policy skipped a state or accepted stale, unapproved or wrong-SHA evidence'
GATE_REPAIR='repair scripts/acceptance-lifecycle.mjs; keep every negative fixture fail-closed'
GATE_OWNER='scripts/acceptance-lifecycle.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate the Issue lifecycle policy." || return $?
  gate_require_path './scripts/acceptance-lifecycle.mjs' "Restore scripts/acceptance-lifecycle.mjs." || return $?
  gate_run_invariant node scripts/acceptance-lifecycle.mjs self-test
}
gate_main "$@"
