#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='repo-metrics-selftest'
GATE_NAME='Repository metrics generator contract'
GATE_COMMAND='node scripts/generate-repo-metrics.mjs --self-test'
GATE_SUCCESS='repository metrics generator self-tests pass'
GATE_FAILURE='repository metrics generation no longer satisfies its self-test contract'
GATE_REPAIR='fix the generator/fixture before publishing repository metrics'
GATE_OWNER='scripts/generate-repo-metrics.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/generate-repo-metrics.mjs --self-test
}

gate_main "$@"
