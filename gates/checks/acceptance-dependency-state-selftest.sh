#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$GATE_DIR/../lib/common.sh"
GATE_ID='acceptance-dependency-state-selftest'
GATE_NAME='Event-driven Acceptance readiness state machine'
GATE_COMMAND='node scripts/acceptance-dependency-state.mjs self-test'
GATE_SUCCESS='Typed waiting, ready, blocked and superseded snapshots are correctly classified'
GATE_FAILURE='Unverified asynchronous completion can prematurely replay Acceptance'
GATE_REPAIR='Repair readiness reducer; do not bypass exact-SHA or failed-only checks'
GATE_OWNER='scripts/acceptance-dependency-state.mjs'
gate_check() {
  gate_require_command node "Node.js required for Acceptance source readiness." || return $?
  gate_run_invariant node scripts/acceptance-dependency-state.mjs self-test
}
gate_main "$@"