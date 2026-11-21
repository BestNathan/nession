#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-test-route-contract'
GATE_NAME='Rust test route workspace coverage contract'
GATE_COMMAND='node scripts/rust-test-route.mjs --validate --selftest'
GATE_SUCCESS='the required Rust Quality route selects every test-capable workspace target'
GATE_FAILURE='the Rust test route omits a test-capable crate/target, a required test Gate or a declared exclusion'
GATE_REPAIR='restore rust-test-unit/rust-test-integration in quality-rust, keep the route workspace-wide and repair the failing fixture'
GATE_OWNER='scripts/rust-test-route.mjs + gates/suites/quality-rust.gates'

gate_check() {
  gate_require_command node "Install Node.js to validate the Rust test route." || return $?
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_path "./scripts/rust-test-route.mjs" "Restore scripts/rust-test-route.mjs." || return $?
  gate_require_path "./scripts/filtered-test.sh" "Restore scripts/filtered-test.sh." || return $?
  gate_run_invariant node scripts/rust-test-route.mjs --validate --selftest
}

gate_main "$@"
