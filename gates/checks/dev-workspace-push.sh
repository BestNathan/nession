#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='dev-workspace-push'
GATE_NAME='Development workspace push policy'
GATE_COMMAND='./scripts/check-dev-workspace.sh push'
GATE_SUCCESS='push is running from an allowed linked development worktree'
GATE_FAILURE='the current checkout violates the repository push workspace policy'
GATE_REPAIR='push from a linked feature worktree; never push development from the root main checkout'
GATE_OWNER='scripts/check-dev-workspace.sh'

gate_check() {
  gate_require_command git "Install git and rerun the gate." || return $?
  gate_require_path "./scripts/check-dev-workspace.sh" "Restore scripts/check-dev-workspace.sh." || return $?
  gate_run_invariant ./scripts/check-dev-workspace.sh push
}

gate_main "$@"
