#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='pre-push-diff-base-selftest'
GATE_NAME='Pre-push diff-base selection regression fixtures'
GATE_COMMAND='bash scripts/test-pre-push-diff-base.sh'
GATE_SUCCESS='new/stacked/orphan branch scenarios choose safe diff bases and expose their own changed files'
GATE_FAILURE='the Git diff-base router regressed or an invalid branch topology was accepted'
GATE_REPAIR='repair scripts/lib/git-diff-base.sh and its fixture; do not silently discard a missing/failed diff'
GATE_OWNER='scripts/lib/git-diff-base.sh + scripts/test-pre-push-diff-base.sh'
gate_check() {
  gate_require_command git "Install Git and rerun the diff-base contract fixtures." || return $?
  gate_run_invariant bash scripts/test-pre-push-diff-base.sh
}
gate_main "$@"
