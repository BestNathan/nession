#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='ghcr-gitops-separation'
GATE_NAME='GHCR GitOps and independent ACR mirror boundary'
GATE_COMMAND='node scripts/ci/ghcr-gitops-separation.mjs --self-test'
GATE_SUCCESS='only GHCR drives GitOps and all ACR failures are isolated'
GATE_FAILURE='ACR is reintroduced as a blocking deployment dependency'
GATE_REPAIR='restore GHCR writer and independent ACR workflow at the canonical owner'
GATE_OWNER='scripts/ci/ghcr-gitops-separation.mjs'
gate_check() {
  gate_require_command node 'Node.js required for GHCR-GitOps separation fixture.' || return $?
  gate_run_invariant node scripts/ci/ghcr-gitops-separation.mjs --self-test
}
gate_main "$@"
