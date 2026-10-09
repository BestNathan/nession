#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-test-unit'
GATE_NAME='Rust unit tests'
GATE_COMMAND='./scripts/filtered-test.sh --lib'
GATE_SUCCESS='all Rust unit tests pass'
GATE_FAILURE='a Rust unit test failed'
GATE_REPAIR='fix the failing unit behavior/test and rerun this gate'
GATE_OWNER='scripts/filtered-test.sh + Rust tests'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command tmux "Install tmux; the test harness requires isolated tmux sessions." || return $?
  gate_require_path "./scripts/filtered-test.sh" "Restore scripts/filtered-test.sh." || return $?
  gate_run_invariant ./scripts/filtered-test.sh --lib
}

gate_main "$@"
