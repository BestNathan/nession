#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='compose-storage-contract-selftest'
GATE_NAME='Docker Compose durable storage detector contract'
GATE_COMMAND='node scripts/compose-storage-contract.mjs --self-test'
GATE_SUCCESS='the storage contract accepts the baseline and rejects every known volume/env regression'
GATE_FAILURE='a known Compose persistence regression escaped the guard'
GATE_REPAIR='restore the guard detection; never weaken the Compose durable-storage contract'
GATE_OWNER='scripts/compose-storage-contract.mjs --self-test'

gate_check() {
  gate_require_command node "Install Node.js to run the Compose storage self-test." || return $?
  gate_run_invariant node scripts/compose-storage-contract.mjs --self-test
}

gate_main "$@"
