#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-storage-contract-selftest'
GATE_NAME='GitOps durable storage detector contract'
GATE_COMMAND='node scripts/gitops-storage-contract.mjs --self-test'
GATE_SUCCESS='the rendered-storage contract accepts the baseline tree and rejects every known persistence/identity regression'
GATE_FAILURE='a known GitOps storage regression escaped the detector'
GATE_REPAIR='restore the detector fixture coverage; never weaken the GitOps storage contract'
GATE_OWNER='scripts/gitops-storage-contract.mjs --self-test'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps storage self-test." || return $?
  gate_run_invariant node scripts/gitops-storage-contract.mjs --self-test
}

gate_main "$@"
