#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-event-deployment-selftest'
GATE_NAME='Opt-in Acceptance deployment safety contract'
GATE_COMMAND='node scripts/acceptance-event-deployment-selftest.mjs'
GATE_SUCCESS='Shadow mode, loopback binding, durable SQLite, separate App env files and fail-closed live opt-in'
GATE_FAILURE='Unsafe Compose default enables live dispatch, exposes HTTP or loses durable Inbox'
GATE_REPAIR='repair deploy/acceptance-relay/compose.yaml and its operator README'
GATE_OWNER='deploy/acceptance-relay/compose.yaml'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-event-deployment-selftest.mjs' "Restore deployment safety fixtures." || return $?
  gate_run_invariant node scripts/acceptance-event-deployment-selftest.mjs
}
gate_main "$@"
