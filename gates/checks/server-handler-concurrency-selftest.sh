#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='server-handler-concurrency-selftest'
GATE_NAME='Independent Server Handler Git worktrees'
GATE_COMMAND='node scripts/server-handler-concurrency-selftest.mjs'
GATE_SUCCESS='two independent versioned handler edits merge without overlapping files or losing changes'
GATE_FAILURE='isolated handler worktree edits produced conflicts, drift or missing results'
GATE_REPAIR='fix handler locality or the deterministic Git-worktree fixture; do not weaken the merge proof'
GATE_OWNER='scripts/server-handler-concurrency-selftest.mjs + crates/nession-server/src/server/handler'
gate_check() {
  gate_require_command node "Install Node.js and rerun the worktree fixture." || return $?
  gate_require_command git "Install Git and rerun the worktree fixture." || return $?
  gate_run_invariant node scripts/server-handler-concurrency-selftest.mjs
}
gate_main "$@"
