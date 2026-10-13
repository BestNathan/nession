#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-e2e-import-selftest'
GATE_NAME='Issue E2E import and CLI entrypoint invariants'
GATE_COMMAND='node scripts/issue-e2e-import-selftest.mjs'
GATE_SUCCESS='reusable Issue E2E modules import safely and direct CLI self-tests pass'
GATE_FAILURE='Issue E2E module import accidentally executed CLI or CLI behavior regressed'
GATE_REPAIR='guard executable CLI entrypoints with import.meta.url and retain self-tests'
GATE_OWNER='scripts/issue-e2e-import-selftest.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun Issue E2E import Gate." || return $?
  gate_run_invariant node scripts/issue-e2e-import-selftest.mjs
}

gate_main "$@"
