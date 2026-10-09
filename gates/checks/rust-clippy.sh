#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rust-clippy'
GATE_NAME='Rust clippy'
GATE_COMMAND='cargo clippy --workspace --all-targets -- -D warnings'
GATE_SUCCESS='all Rust workspace targets pass clippy with zero warnings'
GATE_FAILURE='clippy reported a warning or lint error in a workspace target'
GATE_REPAIR='fix the reported lint at its owner; do not add an allow merely to make the gate green'
GATE_OWNER='Rust workspace + clippy.toml'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_run_invariant cargo clippy --workspace --all-targets -- -D warnings
}

gate_main "$@"
