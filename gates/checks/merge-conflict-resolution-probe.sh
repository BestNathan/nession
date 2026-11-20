#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='merge-conflict-resolution-probe'
GATE_NAME='Source-pinned source repair and two-parent integration Git fixtures'
GATE_COMMAND='node scripts/merge-conflict-resolution-probe.mjs self-test'
GATE_SUCCESS='both Git repair strategies pass their positive/negative source and tree identity fixtures'
GATE_FAILURE='a stale source, unresolved merge, unrelated edit or invalid candidate was accepted'
GATE_REPAIR='fix scripts/merge-conflict-resolution-probe.mjs while preserving immutable source-pair verification'
GATE_OWNER='scripts/merge-conflict-resolution-probe.mjs'

gate_check() {
  gate_require_command node 'Install Node.js for conflict probe fixtures.' || return $?
  gate_require_command git 'Install Git for real merge-tree/commit-tree fixtures.' || return $?
  gate_run_invariant node scripts/merge-conflict-resolution-probe.mjs self-test
}

gate_main "$@"
