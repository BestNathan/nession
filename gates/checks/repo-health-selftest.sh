#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='repo-health-selftest'
GATE_NAME='Repository health collector contract'
GATE_COMMAND='node scripts/collect-repo-health.mjs --self-test'
GATE_SUCCESS='repository health collection self-tests pass'
GATE_FAILURE='repository health collection no longer satisfies its self-test contract'
GATE_REPAIR='fix the collector or fixture before using its metrics'
GATE_OWNER='scripts/collect-repo-health.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/collect-repo-health.mjs --self-test
}

gate_main "$@"
