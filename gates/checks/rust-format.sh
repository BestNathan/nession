#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-format'
GATE_NAME='Rust formatting'
GATE_COMMAND='cargo fmt --all -- --check'
GATE_SUCCESS='all Rust sources match rustfmt'
GATE_FAILURE='Rust source formatting differs from rustfmt output'
GATE_REPAIR='run `cargo fmt --all`, review the changes, and rerun this gate'
GATE_OWNER='Rust workspace + rustfmt'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_run_invariant cargo fmt --all -- --check
}

gate_main "$@"
