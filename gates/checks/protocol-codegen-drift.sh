#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='protocol-codegen-drift'
GATE_NAME='Protocol generated binding drift'
GATE_COMMAND='./scripts/check-codegen-drift.sh'
GATE_SUCCESS='committed Web protocol bindings exactly match the Rust contracts'
GATE_FAILURE='generated protocol bindings differ from current Rust contract output'
GATE_REPAIR='run `just codegen` and commit the generated result; never edit generated bindings by hand'
GATE_OWNER='scripts/check-codegen-drift.sh + nession-protocol-codegen'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command diff "Install diff and rerun the gate." || return $?
  gate_run_invariant ./scripts/check-codegen-drift.sh
}

gate_main "$@"
