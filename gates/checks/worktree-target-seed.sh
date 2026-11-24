#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='worktree-target-seed'
GATE_NAME='Worktree target seed contract'
GATE_COMMAND='bash ./scripts/seed-worktree-target-selftest.sh && bash ./scripts/seed-worktree-base-selftest.sh && bash ./scripts/build-cache-status-selftest.sh'
GATE_SUCCESS='worktree warm seeding stays private, resolves a deterministic source (explicit > dedicated base > main), maintains a detached warm base, refuses full copies, proves source quiescence, and reports seeded/skipped/failed honestly'
GATE_FAILURE='the worktree target seeding contract (classification, CoW, quiescence, cleanup, source resolution, base maintenance, status reporting or hook reporting) was violated'
GATE_REPAIR='fix scripts/seed-worktree-target.sh, scripts/seed-worktree-base.sh, scripts/build-cache-status.sh or .claude/hooks/create-worktree.sh so seeding stays private and honest'
GATE_OWNER='scripts/seed-worktree-target.sh + scripts/seed-worktree-base.sh + scripts/build-cache-status.sh + their selftests + .claude/hooks/create-worktree.sh'

gate_check() {
  gate_require_path './scripts/seed-worktree-target-selftest.sh' 'Restore ./scripts/seed-worktree-target-selftest.sh.' || return $?
  gate_require_path './scripts/seed-worktree-base-selftest.sh' 'Restore ./scripts/seed-worktree-base-selftest.sh.' || return $?
  gate_require_path './scripts/build-cache-status-selftest.sh' 'Restore ./scripts/build-cache-status-selftest.sh.' || return $?
  gate_run_invariant bash ./scripts/seed-worktree-target-selftest.sh
  gate_run_invariant bash ./scripts/seed-worktree-base-selftest.sh
  gate_run_invariant bash ./scripts/build-cache-status-selftest.sh
}

gate_main "$@"
