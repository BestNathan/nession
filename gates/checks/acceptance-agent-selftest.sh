#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acceptance-agent-selftest'
GATE_NAME='Acceptance Agent contract'
GATE_COMMAND='node scripts/acceptance-agent.mjs self-test'
GATE_SUCCESS='Acceptance Agent provider-independent fixtures pass'
GATE_FAILURE='Acceptance Agent failed its deterministic self-test'
GATE_REPAIR='fix the agent harness contract before running model-backed acceptance'
GATE_OWNER='scripts/acceptance-agent.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/acceptance-agent.mjs self-test
}

gate_main "$@"
