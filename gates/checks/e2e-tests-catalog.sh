#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-tests-catalog'
GATE_NAME='Canonical file-ID E2E Tests catalog'
GATE_COMMAND='node e2e/runner/test-catalog-selftest.cjs && ./e2e/run test --list'
GATE_SUCCESS='E2E regression file IDs are unique, deterministic and discoverable'
GATE_FAILURE='E2E file IDs conflict, are unsafe or the tests catalog is empty'
GATE_REPAIR='repair e2e/tests file naming and the canonical e2e/runner/test-catalog.cjs owner'
GATE_OWNER='e2e/runner/test-catalog.cjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the catalog Gate." || return $?
  gate_run_invariant bash -c 'node e2e/runner/test-catalog-selftest.cjs && ./e2e/run test --list >/dev/null'
}

gate_main "$@"
