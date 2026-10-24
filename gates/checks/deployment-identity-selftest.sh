#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='deployment-identity-selftest'
GATE_NAME='Deployment identity attestation policy and observer'
GATE_COMMAND='node scripts/deployment-identity-policy.mjs self-test && node scripts/deployment-identity-collect.mjs self-test && node scripts/deployment-attestation-ingest.mjs self-test && node scripts/deployment-binding-lookup.mjs self-test && node scripts/staging-lane-scheduler.mjs self-test'
GATE_SUCCESS='GitOps tags, immutable digests, ready workloads, store ingestion, binding selection and lane admission bind one source SHA fail-closed'
GATE_FAILURE='the identity chain accepted missing, stale, cross-lane, ambiguous or mismatched deployment or store evidence'
GATE_REPAIR='repair the deployment identity policy/collector/ingester/lookup; keep every negative fixture fail-closed'
GATE_OWNER='scripts/deployment-identity-policy.mjs + scripts/deployment-identity-collect.mjs + scripts/deployment-attestation-ingest.mjs + scripts/deployment-binding-lookup.mjs + scripts/staging-lane-scheduler.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate the deployment identity policy." || return $?
  gate_require_path './scripts/deployment-identity-policy.mjs' "Restore scripts/deployment-identity-policy.mjs." || return $?
  gate_require_path './scripts/deployment-identity-collect.mjs' "Restore scripts/deployment-identity-collect.mjs." || return $?
  gate_require_path './scripts/deployment-attestation-ingest.mjs' "Restore scripts/deployment-attestation-ingest.mjs." || return $?
  gate_require_path './scripts/deployment-binding-lookup.mjs' "Restore scripts/deployment-binding-lookup.mjs." || return $?
  gate_require_path './scripts/staging-lane-scheduler.mjs' "Restore scripts/staging-lane-scheduler.mjs." || return $?
  gate_run_invariant node scripts/deployment-identity-policy.mjs self-test
  gate_run_invariant node scripts/deployment-identity-collect.mjs self-test
  gate_run_invariant node scripts/deployment-attestation-ingest.mjs self-test
  gate_run_invariant node scripts/deployment-binding-lookup.mjs self-test
  gate_run_invariant node scripts/staging-lane-scheduler.mjs self-test
}
gate_main "$@"
