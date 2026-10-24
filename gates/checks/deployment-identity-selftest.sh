#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='deployment-identity-selftest'
GATE_NAME='Deployment identity attestation policy'
GATE_COMMAND='node scripts/deployment-identity-policy.mjs self-test'
GATE_SUCCESS='GitOps tags, immutable digests and observed ready workloads bind to one source SHA fail-closed'
GATE_FAILURE='the identity policy accepted missing, stale, cross-lane or mismatched deployment evidence'
GATE_REPAIR='repair scripts/deployment-identity-policy.mjs; keep every negative fixture fail-closed'
GATE_OWNER='scripts/deployment-identity-policy.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate the deployment identity policy." || return $?
  gate_require_path './scripts/deployment-identity-policy.mjs' "Restore scripts/deployment-identity-policy.mjs." || return $?
  gate_run_invariant node scripts/deployment-identity-policy.mjs self-test
}
gate_main "$@"
