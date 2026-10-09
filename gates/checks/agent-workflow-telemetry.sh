#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='agent-workflow-telemetry'
GATE_NAME='Agent workflow telemetry contract'
GATE_COMMAND='node scripts/agent-workflow-telemetry.mjs self-test && node scripts/agent-workflow-telemetry-contract.mjs self-test && node scripts/agent-workflow-telemetry-contract.mjs check'
GATE_SUCCESS='Agent workflows emit canonical telemetry and are covered by metrics ingest'
GATE_FAILURE='an Agent workflow is missing canonical telemetry, stable identity, or metrics-ingest coverage'
GATE_REPAIR='load nession-agent-workflow-metrics, emit an agent-telemetry artifact, and register the top-level workflow with Metrics Ingest'
GATE_OWNER='scripts/agent-workflow-telemetry-contract.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant bash -c 'node scripts/agent-workflow-telemetry.mjs self-test && node scripts/agent-workflow-telemetry-contract.mjs self-test && node scripts/agent-workflow-telemetry-contract.mjs check'
}

gate_main "$@"
