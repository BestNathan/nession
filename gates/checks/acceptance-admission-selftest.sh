#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$GATE_DIR/../lib/common.sh"
GATE_ID='acceptance-admission-selftest'
GATE_NAME='Pre-merge admission deferral and ready-transition replay contract'
GATE_COMMAND='node scripts/acceptance-admission-selftest.mjs'
GATE_SUCCESS='the initial PR event defers without a verdict, applicability is source-derived, and only a ready transition replays the exact run'
GATE_FAILURE='an initial PR event can report a false failure or a passing gate, or a deferred run can be replayed without verified ready evidence'
GATE_REPAIR='repair the checked-in admission wiring and its fixtures without restoring one-time source snapshots or inferred Pass'
GATE_OWNER='scripts/acceptance-admission-selftest.mjs + .github/workflows/acceptance-orchestrator.yml'
gate_check() {
  gate_require_command node "Install Node.js to verify pre-merge admission." || return $?
  gate_require_path './scripts/acceptance-admission-selftest.mjs' "Restore the admission selftest." || return $?
  gate_require_path './scripts/acceptance-source-applicability.mjs' "Restore the canonical source applicability reader." || return $?
  gate_require_path './.github/workflows/acceptance-orchestrator.yml' "Restore the trusted Acceptance Orchestrator." || return $?
  gate_run_invariant node scripts/acceptance-admission-selftest.mjs || return $?
  gate_run_invariant node scripts/acceptance-source-applicability.mjs self-test || return $?
  gate_run_invariant node scripts/acceptance-dependency-state.mjs self-test || return $?
}
gate_main "$@"
