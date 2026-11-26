#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='mcp-standalone-image'
GATE_NAME='Standalone MCP OCI image release and deployment contract'
GATE_COMMAND='node scripts/mcp-standalone-image.mjs'
GATE_SUCCESS='the dedicated MCP image selects the architecture-matched binary, excludes Server/Agent/UI payloads and credentials, and is published/provenanced by the existing staging/production/ACR lanes with atomic staging/production GitOps version alignment'
GATE_FAILURE='the standalone MCP image, its release wiring or its independent read-only deployment sample drifted from the canonical contract'
GATE_REPAIR='restore Dockerfile.mcp.prebuilt, the mcp-bin artifacts and mcp-<tag> jobs in release-staging/release-production/deploy-staging-acr, the source verifier JOBS, the ACR mirror mapping and the standalone Compose/example; preserve separate MCP overlays and the common staging/production release identity'
GATE_OWNER='scripts/mcp-standalone-image.mjs + Dockerfile.mcp.prebuilt + release workflows + deploy/docker-compose.mcp.yml'

gate_check() {
  gate_require_command node "Install Node.js to validate the standalone MCP image contract." || return $?
  gate_run_invariant node scripts/mcp-standalone-image.mjs
}

gate_main "$@"
