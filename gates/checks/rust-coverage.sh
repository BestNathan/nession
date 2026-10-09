#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-coverage'
GATE_NAME='Rust coverage thresholds'
GATE_COMMAND='./scripts/check-coverage.sh'
GATE_SUCCESS='all configured Rust crates meet their line coverage thresholds'
GATE_FAILURE='one or more Rust crates are below the repository coverage threshold'
GATE_REPAIR='add tests for uncovered behavior; use `cargo llvm-cov -p <crate> --html` to inspect gaps'
GATE_OWNER='scripts/check-coverage.sh'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command jq "Install jq and rerun the gate." || return $?
  gate_require_command cargo-llvm-cov "Install with `cargo install cargo-llvm-cov` and add llvm-tools-preview." || return $?
  gate_require_command tmux "Install tmux; coverage executes the Rust tests." || return $?
  gate_run_invariant ./scripts/check-coverage.sh
}

gate_main "$@"
