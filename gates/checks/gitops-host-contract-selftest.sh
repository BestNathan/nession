#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-host-contract-selftest'
GATE_NAME='GitOps canonical hostname detector contract'
GATE_COMMAND='node scripts/gitops-host-contract.mjs --self-test'
GATE_SUCCESS='the hostname contract accepts the baseline tree and rejects every known canonical-host/backend/nhome.local/dormancy regression'
GATE_FAILURE='a known GitOps hostname regression escaped the detector'
GATE_REPAIR='restore the detector fixture coverage; never weaken the GitOps hostname contract'
GATE_OWNER='scripts/gitops-host-contract.mjs --self-test (#4588)'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps hostname self-test." || return $?
  gate_run_invariant node scripts/gitops-host-contract.mjs --self-test
}

gate_main "$@"
