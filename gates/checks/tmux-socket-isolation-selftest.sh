#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='tmux-socket-isolation-selftest'
GATE_NAME='tmux socket checker contract'
GATE_COMMAND='./scripts/check-tmux-socket-selftest.sh'
GATE_SUCCESS='the tmux socket checker detects every known unsafe spawn form'
GATE_FAILURE='the tmux socket checker stopped catching a violation it claims to prevent'
GATE_REPAIR='fix the checker/fixture; do not loosen the explicit-socket invariant'
GATE_OWNER='scripts/check-tmux-socket.sh + scripts/check-tmux-socket-selftest.sh'

gate_check() {
  gate_require_path './scripts/check-tmux-socket-selftest.sh' 'Restore ./scripts/check-tmux-socket-selftest.sh.' || return $?
  gate_run_invariant ./scripts/check-tmux-socket-selftest.sh
}

gate_main "$@"
