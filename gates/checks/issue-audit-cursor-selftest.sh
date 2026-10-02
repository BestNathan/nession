#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-audit-cursor-selftest'
GATE_NAME='Cursor issue audit contract'
GATE_COMMAND='node scripts/issue-audit-cursor.mjs self-test'
GATE_SUCCESS='Cursor issue audit self-tests pass'
GATE_FAILURE='the Cursor issue-audit adapter failed its deterministic self-test'
GATE_REPAIR='fix the Cursor adapter contract without bypassing its validation'
GATE_OWNER='scripts/issue-audit-cursor.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/issue-audit-cursor.mjs self-test
}

gate_main "$@"
