#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='mcp-standalone-image-selftest'
GATE_NAME='Standalone MCP image detector negative fixtures'
GATE_COMMAND='node scripts/mcp-standalone-image.mjs --self-test'
GATE_SUCCESS='the MCP image detector accepts the release contract and rejects every known payload, architecture, release, provenance, deployment and GitOps mutation'
GATE_FAILURE='a known standalone MCP image release/deployment regression escaped the detector'
GATE_REPAIR='restore the detector checks; never weaken the image/release/deployment contract to make it pass'
GATE_OWNER='scripts/mcp-standalone-image.mjs --self-test'

gate_check() {
  gate_require_command node "Install Node.js to run the standalone MCP image detector self-test." || return $?
  gate_run_invariant node scripts/mcp-standalone-image.mjs --self-test
}

gate_main "$@"
