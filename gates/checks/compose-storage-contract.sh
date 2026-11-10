#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='compose-storage-contract'
GATE_NAME='Docker Compose durable EROFS storage'
GATE_COMMAND='node scripts/compose-storage-contract.mjs'
GATE_SUCCESS='the Compose Server and both Agents mount distinct named volumes at their declared durable roots'
GATE_FAILURE='a Compose service lost its durable root, shared a volume, or declared a non-persistent path override'
GATE_REPAIR='restore NESSION_HOME plus its matching named volume for Server/Agents; never reuse one Agent volume for another'
GATE_OWNER='scripts/compose-storage-contract.mjs + deploy/docker-compose.yml'

gate_check() {
  gate_require_command node "Install Node.js to run the Compose storage contract." || return $?
  gate_run_invariant node scripts/compose-storage-contract.mjs
}

gate_main "$@"
