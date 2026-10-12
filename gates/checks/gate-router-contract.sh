#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='gate-router-contract'
GATE_NAME='Git hook Gate routing contract'
GATE_COMMAND='node scripts/gate-router-selftest.mjs'
GATE_SUCCESS='hooks route owner changes to required blocking Gates/self-tests; unprovable diffs broaden checks'
GATE_FAILURE='pre-commit/pre-push routing lost a required Gate or negative fixture'
GATE_REPAIR='repair canonical hook path selection; rerun deterministic routing fixtures without bypassing'
GATE_OWNER='.githooks/pre-commit + .githooks/pre-push + scripts/gate-router-selftest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run deterministic hook fixtures." || return $?
  gate_run_invariant node scripts/gate-router-selftest.mjs
}
gate_main "$@"
