#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='mcp-image-default'
GATE_NAME='Authenticated MCP defaults for Server and Agent OCI images'
GATE_COMMAND='node scripts/mcp-image-config.test.mjs'
GATE_SUCCESS='both roles enable MCP with correct inbound tokens and fail-closed overrides; source/prebuilt and nginx/TLS contracts agree'
GATE_FAILURE='image MCP configuration failed closed, a default drifted, or a package lacks ingress/entrypoint'
GATE_REPAIR='restore deploy/render-mcp-config.sh, entrypoints, nginx and four Dockerfile copy paths; preserve native opt-in'
GATE_OWNER='scripts/mcp-image-config.test.mjs + deploy/* + Dockerfile.{server,agent}{,.prebuilt}'

gate_check() {
  gate_require_command node "Install Node.js to validate MCP image defaults." || return $?
  gate_require_command sh "Install POSIX sh for MCP renderer fixtures." || return $?
  gate_run_invariant node scripts/mcp-image-config.test.mjs
}

gate_main "$@"
