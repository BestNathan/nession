#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='mcp-secret-preflight-readback-selftest'
GATE_NAME='Temporary MCP Pod-based Secret consumption readback'
GATE_COMMAND='node scripts/ci/mcp-secret-preflight-readback.mjs self-test'
GATE_SUCCESS='only the exact Pod owner and Secret references with successful termination can pass'
GATE_FAILURE='Pod identity, Secret references, or readback failure classification is unsafe'
GATE_REPAIR='repair scripts/ci/mcp-secret-preflight-readback.mjs and its fixture selftest'
GATE_OWNER='scripts/ci/mcp-secret-preflight-readback.mjs'

gate_check() {
  gate_require_command node "Install Node.js for MCP Secret readback verification." || return $?
  gate_run_invariant node scripts/ci/mcp-secret-preflight-readback.mjs self-test
}

gate_main "$@"
