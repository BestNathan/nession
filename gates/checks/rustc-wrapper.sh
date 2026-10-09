#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='rustc-wrapper'
GATE_NAME='Rust compiler wrapper contract'
GATE_COMMAND='bash ./scripts/rustc-wrapper-selftest.sh'
GATE_SUCCESS='the local rustc wrapper selects sccache/fallback behavior correctly'
GATE_FAILURE='the rustc wrapper no longer satisfies its repository contract'
GATE_REPAIR='fix scripts/rustc-wrapper.sh or its contract; do not bypass the wrapper self-test'
GATE_OWNER='scripts/rustc-wrapper.sh + scripts/rustc-wrapper-selftest.sh'

gate_check() {
  gate_require_path './scripts/rustc-wrapper-selftest.sh' 'Restore ./scripts/rustc-wrapper-selftest.sh.' || return $?
  gate_run_invariant bash ./scripts/rustc-wrapper-selftest.sh
}

gate_main "$@"
