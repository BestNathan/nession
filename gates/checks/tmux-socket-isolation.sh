#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='tmux-socket-isolation'
GATE_NAME='tmux socket isolation'
GATE_COMMAND='./scripts/check-tmux-socket.sh'
GATE_SUCCESS='every repository tmux spawn uses an explicit private socket'
GATE_FAILURE='a tmux invocation can reach the user'"'"'s default tmux server'
GATE_REPAIR='route the call through the canonical tmux helper or pass the required private `-S` socket'
GATE_OWNER='scripts/check-tmux-socket.sh'

gate_check() {
  gate_require_path './scripts/check-tmux-socket.sh' 'Restore ./scripts/check-tmux-socket.sh.' || return $?
  gate_run_invariant ./scripts/check-tmux-socket.sh
}

gate_main "$@"
