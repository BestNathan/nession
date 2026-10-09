#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='build-cache-verifier'
GATE_NAME='Build-cache verifier contract'
GATE_COMMAND='bash ./scripts/build-cache-verify-selftest.sh'
GATE_SUCCESS='the cache verifier still detects shared or aliased worktree targets'
GATE_FAILURE='the cache verifier no longer detects a known invalid cache topology'
GATE_REPAIR='fix scripts/build-cache-verify.sh/selftest rather than weakening the expected violation'
GATE_OWNER='scripts/build-cache-verify.sh + scripts/build-cache-verify-selftest.sh'

gate_check() {
  gate_require_path './scripts/build-cache-verify-selftest.sh' 'Restore ./scripts/build-cache-verify-selftest.sh.' || return $?
  gate_run_invariant bash ./scripts/build-cache-verify-selftest.sh
}

gate_main "$@"
