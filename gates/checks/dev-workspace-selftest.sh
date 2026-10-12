#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='dev-workspace-selftest'
GATE_NAME='Git workspace policy positive and negative scenarios'
GATE_COMMAND='bash scripts/check-dev-workspace-selftest.sh'
GATE_SUCCESS='root, linked worktree, detached head and invalid inputs obey the workspace policy'
GATE_FAILURE='worktree/root policy accepted a forbidden operation or rejected a valid operation'
GATE_REPAIR='repair scripts/check-dev-workspace.sh and the isolated Git-worktree fixture, never bypass the Hook policy'
GATE_OWNER='scripts/check-dev-workspace.sh + scripts/check-dev-workspace-selftest.sh'
gate_check() {
  gate_require_command git "Install Git to evaluate isolated worktree policy fixtures." || return $?
  gate_run_invariant bash scripts/check-dev-workspace-selftest.sh
}
gate_main "$@"
