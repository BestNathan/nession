#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='websocket-route-inventory'
GATE_NAME='WebSocket route inventory'
GATE_COMMAND='node scripts/websocket-route-inventory.mjs'
GATE_SUCCESS='every wire served by the Server, Agent central and Agent P2P route declarations appears exactly once in the canonical WebSocket runtime inventory with its declared policy'
GATE_FAILURE='a served wire is undocumented, an inventoried wire is not served, or a documented policy differs from its route declaration'
GATE_REPAIR='update docs/architecture/websocket-runtime.md (the canonical inventory) or the route declaration; do not duplicate a second route registry'
GATE_OWNER='docs/architecture/websocket-runtime.md + scripts/websocket-route-inventory.mjs + route declarations'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/websocket-route-inventory.mjs
  gate_run_invariant node scripts/websocket-route-inventory.mjs --self-test || return $?
}

gate_main "$@"
