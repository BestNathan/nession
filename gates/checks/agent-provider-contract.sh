#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='agent-provider-contract'
GATE_NAME='Agent provider orchestration contract'
GATE_COMMAND='node scripts/lib/agent/provider-smoke.mjs self-test && node scripts/lib/agent/development-selftest.mjs && node scripts/lib/agent/orchestration/outbox-selftest.mjs && node scripts/lib/agent/harness/native-selftest.mjs && node scripts/lib/agent/orchestration/github-dispatch-selftest.mjs && node scripts/lib/agent/orchestration/result-artifact-selftest.mjs && node scripts/lib/agent/developer-canary.mjs self-test'
GATE_SUCCESS='provider invocation, identity, Harness, transition, checkpoint and canonical event fixtures pass'
GATE_FAILURE='a provider or agent development invariant or fixture failed'
GATE_REPAIR='fix canonical agent/provider contract implementation; do not suppress a fixture'
GATE_OWNER='scripts/lib/agent/provider-smoke.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run provider contract fixtures." || return $?
  gate_run_invariant bash -c 'node scripts/lib/agent/provider-smoke.mjs self-test && node scripts/lib/agent/development-selftest.mjs && node scripts/lib/agent/orchestration/outbox-selftest.mjs && node scripts/lib/agent/harness/native-selftest.mjs && node scripts/lib/agent/orchestration/github-dispatch-selftest.mjs && node scripts/lib/agent/orchestration/result-artifact-selftest.mjs && node scripts/lib/agent/developer-canary.mjs self-test'
}
gate_main "$@"
