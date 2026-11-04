#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='worktree-target-seed'
GATE_NAME='Worktree target seed contract'
GATE_COMMAND='bash ./scripts/seed-worktree-target-selftest.sh'
GATE_SUCCESS='worktree warm seeding stays private, refuses full copies, proves source quiescence, and reports seeded/skipped/failed honestly'
GATE_FAILURE='the worktree target seeding contract (classification, CoW, quiescence, cleanup or hook reporting) was violated'
GATE_REPAIR='fix scripts/seed-worktree-target.sh or .claude/hooks/create-worktree.sh so seeding stays private and honest'
GATE_OWNER='scripts/seed-worktree-target.sh + scripts/seed-worktree-target-selftest.sh + .claude/hooks/create-worktree.sh'

gate_check() {
  gate_require_path './scripts/seed-worktree-target-selftest.sh' 'Restore ./scripts/seed-worktree-target-selftest.sh.' || return $?
  gate_run_invariant bash ./scripts/seed-worktree-target-selftest.sh
}

gate_main "$@"
