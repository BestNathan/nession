#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acceptance-executor-selftest'
GATE_NAME='Acceptance executor contract'
GATE_COMMAND='node scripts/acceptance-executor.mjs self-test'
GATE_SUCCESS='Acceptance executor normalization/update fixtures pass'
GATE_FAILURE='Acceptance executor failed its deterministic self-test'
GATE_REPAIR='fix the executor/fixture before applying Acceptance Results'
GATE_OWNER='scripts/acceptance-executor.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/acceptance-executor.mjs self-test
}

gate_main "$@"
