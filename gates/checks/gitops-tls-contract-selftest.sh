#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-tls-contract-selftest'
GATE_NAME='GitOps certificate ownership detector contract'
GATE_COMMAND='node scripts/gitops-tls-contract.mjs --self-test'
GATE_SUCCESS='the TLS contract proves single ownership, no duplicate writer, readiness-gated retirement/switch, and always-allowed rollback'
GATE_FAILURE='a known certificate ownership or retirement-readiness regression escaped the detector'
GATE_REPAIR='restore the detector fixture coverage; never weaken the GitOps TLS contract'
GATE_OWNER='scripts/gitops-tls-contract.mjs --self-test (#4588)'

gate_check() {
  gate_require_command node "Install Node.js to run the GitOps TLS self-test." || return $?
  gate_run_invariant node scripts/gitops-tls-contract.mjs --self-test
}

gate_main "$@"
