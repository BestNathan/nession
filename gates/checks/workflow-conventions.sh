#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='workflow-conventions'
GATE_NAME='GitHub Actions workflow taxonomy and reference integrity'
GATE_COMMAND='node scripts/workflow-conventions.mjs self-test && node scripts/workflow-conventions.mjs check && node scripts/ci-trigger-scope-selftest.mjs && node scripts/ci-trigger-inventory.mjs self-test && node scripts/staging-branch-convergence.mjs self-test && node scripts/staging-branch-convergence.mjs discover && node scripts/staging-convergence-readiness.mjs self-test && node scripts/staging-convergence-batch.mjs self-test && node scripts/staging-convergence-pr.mjs self-test && node scripts/staging-convergence-audit-attest.mjs self-test && node scripts/staging-convergence-agent.mjs self-test'
GATE_SUCCESS='workflow taxonomy, references, staging convergence policy and CI path-scope fixtures are all valid'
GATE_FAILURE='an unclassified workflow, unsafe staging convergence policy, incorrect domain, stale trigger/reference or telemetry source path was found'
GATE_REPAIR='follow nession-workflows; migrate all upstream names, file paths and telemetry provenance as one tested boundary'
GATE_OWNER='scripts/workflow-conventions.mjs'

gate_check() {
  gate_require_command node "Install Node.js to verify GitHub Actions workflow contracts." || return $?
  gate_run_invariant bash -c 'node scripts/workflow-conventions.mjs self-test && node scripts/workflow-conventions.mjs check && node scripts/ci-trigger-scope-selftest.mjs && node scripts/ci-trigger-inventory.mjs self-test && node scripts/staging-branch-convergence.mjs self-test && node scripts/staging-branch-convergence.mjs discover && node scripts/staging-convergence-readiness.mjs self-test && node scripts/staging-convergence-batch.mjs self-test && node scripts/staging-convergence-pr.mjs self-test && node scripts/staging-convergence-audit-attest.mjs self-test && node scripts/staging-convergence-agent.mjs self-test'
}
gate_main "$@"
