#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-test-unit'
GATE_NAME='Rust unit tests'
GATE_COMMAND='./scripts/filtered-test.sh --route unit'
GATE_SUCCESS='all Rust lib/bin unit tests in every workspace crate pass'
GATE_FAILURE='a Rust unit test failed'
GATE_REPAIR='fix the failing unit behavior/test and rerun this gate'
GATE_OWNER='scripts/rust-test-route.mjs + scripts/filtered-test.sh + Rust tests'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command node "Install Node.js; the canonical test route selects targets from workspace metadata." || return $?
  gate_require_command tmux "Install tmux; the test harness requires isolated tmux sessions." || return $?
  gate_require_path "./scripts/rust-test-route.mjs" "Restore scripts/rust-test-route.mjs." || return $?
  gate_require_path "./scripts/filtered-test.sh" "Restore scripts/filtered-test.sh." || return $?
  gate_run_invariant ./scripts/filtered-test.sh --route unit
}

gate_main "$@"
