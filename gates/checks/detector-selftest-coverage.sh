#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='detector-selftest-coverage'
GATE_NAME='Custom detector and deterministic selftest CI coverage'
GATE_COMMAND='node scripts/detector-selftest-coverage.mjs'
GATE_SUCCESS='every mapped detector has a canonical regression selftest selected by unconditional PR Quality'
GATE_FAILURE='a custom detection Gate lost its negative fixture or PR Quality invocation'
GATE_REPAIR='restore the selftest Gate, its Quality consumer and matching known-violation fixtures; do not weaken rules'
GATE_OWNER='scripts/detector-selftest-coverage.mjs + gates/suites/quality-*.gates + quality.yml'
gate_check() {
  gate_require_command node "Install Node.js to run detector coverage mutations." || return $?
  gate_run_invariant node scripts/detector-selftest-coverage.mjs
}
gate_main "$@"
