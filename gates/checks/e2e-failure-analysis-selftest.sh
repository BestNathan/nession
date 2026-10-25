#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-failure-analysis-selftest'
GATE_NAME='E2E failure diagnosis contract and read-only runner'
GATE_COMMAND='node scripts/lib/agent/selftest.mjs && node scripts/e2e-failure-analysis-agent.mjs self-test && node scripts/lib/agent/orchestration/e2e-failure-dispatch.mjs self-test && node scripts/e2e-failure-analysis-dispatch.mjs self-test'
GATE_SUCCESS='the bounded diagnosis contract binds host identity and the runner fails closed on invalid output'
GATE_FAILURE='the diagnosis contract or the read-only analysis runner accepted or emitted an invalid diagnosis'
GATE_REPAIR='fix the diagnosis contract/runner; never weaken the schema or the host identity binding'
GATE_OWNER='scripts/lib/agent/tasks/e2e-failure-analysis.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the diagnosis self-tests." || return $?
  gate_run_invariant bash -c 'node scripts/lib/agent/selftest.mjs && node scripts/e2e-failure-analysis-agent.mjs self-test && node scripts/lib/agent/orchestration/e2e-failure-dispatch.mjs self-test && node scripts/e2e-failure-analysis-dispatch.mjs self-test'
}

gate_main "$@"
