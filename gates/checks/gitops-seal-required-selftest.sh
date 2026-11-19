#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gitops-seal-required-selftest'
GATE_NAME='Environment-only required Secret sealing and atomic GitOps publication'
GATE_COMMAND='node --test scripts/ci/seal-gitops-secret.test.mjs'
GATE_SUCCESS='every registered environment Secret is mandatory; malformed or missing values and ciphertext cannot partially publish GitOps desired state'
GATE_FAILURE='a required Secret, strict ciphertext identity, or atomic publication safety check failed'
GATE_REPAIR='repair scripts/ci/seal-gitops-secret.mjs and its deterministic positive/negative tests'
GATE_OWNER='scripts/ci/seal-gitops-secret.mjs'

gate_check() {
  gate_require_command node "Install Node.js to verify required GitOps Secret publication." || return $?
  gate_run_invariant node --test scripts/ci/seal-gitops-secret.test.mjs
}

gate_main "$@"
