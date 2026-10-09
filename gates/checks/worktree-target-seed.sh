#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='worktree-target-seed'
GATE_NAME='Worktree target seed contract'
GATE_COMMAND='bash ./scripts/seed-worktree-target-selftest.sh'
GATE_SUCCESS='worktree warm seeding remains private and does not publish workspace outputs'
GATE_FAILURE='the worktree target seeding behavior violated its isolation contract'
GATE_REPAIR='fix scripts/seed-worktree-target.sh so seeded targets remain private and safe'
GATE_OWNER='scripts/seed-worktree-target.sh + scripts/seed-worktree-target-selftest.sh'

gate_check() {
  gate_require_path './scripts/seed-worktree-target-selftest.sh' 'Restore ./scripts/seed-worktree-target-selftest.sh.' || return $?
  gate_run_invariant bash ./scripts/seed-worktree-target-selftest.sh
}

gate_main "$@"
