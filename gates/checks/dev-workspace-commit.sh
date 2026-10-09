#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='dev-workspace-commit'
GATE_NAME='Development workspace commit policy'
GATE_COMMAND='./scripts/check-dev-workspace.sh commit'
GATE_SUCCESS='commit is running from an allowed linked development worktree'
GATE_FAILURE='the current checkout violates the repository commit workspace policy'
GATE_REPAIR='refresh the root main checkout and commit from a linked feat/fix/chore/docs worktree'
GATE_OWNER='scripts/check-dev-workspace.sh'

gate_check() {
  gate_require_command git "Install git and rerun the gate." || return $?
  gate_require_path "./scripts/check-dev-workspace.sh" "Restore scripts/check-dev-workspace.sh." || return $?
  gate_run_invariant ./scripts/check-dev-workspace.sh commit
}

gate_main "$@"
