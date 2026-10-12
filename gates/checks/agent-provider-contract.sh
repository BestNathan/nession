#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='agent-provider-contract'
GATE_NAME='Agent provider orchestration contract'
GATE_COMMAND='node scripts/lib/agent/provider-smoke.mjs self-test'
GATE_SUCCESS='deterministic provider invocation/response fixtures pass'
GATE_FAILURE='a provider orchestration invariant or fixture failed'
GATE_REPAIR='fix scripts/lib/agent/provider-smoke.mjs or its canonical provider adapter; do not suppress the fixture'
GATE_OWNER='scripts/lib/agent/provider-smoke.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run provider contract fixtures." || return $?
  gate_run_invariant node scripts/lib/agent/provider-smoke.mjs self-test
}
gate_main "$@"
