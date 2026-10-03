#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='gate-runtime-contract'
GATE_NAME='Gate runtime contract'
GATE_COMMAND='bash gates/lib/common-selftest.sh && bash gates/run-selftest.sh && ./gates/run --validate'
GATE_SUCCESS='the Gate runtime, runner, catalog and suite contracts are internally consistent'
GATE_FAILURE='the Gate runtime/runner/catalog no longer satisfies its deterministic contract'
GATE_REPAIR='fix the Gate runtime or catalog definition; do not bypass catalog validation'
GATE_OWNER='gates/'

gate_check() {
  gate_require_command bash "Install bash and rerun the gate." || return $?
  if bash gates/lib/common-selftest.sh && bash gates/run-selftest.sh && ./gates/run --validate; then
    return 0
  fi
  gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
}

gate_main "$@"
