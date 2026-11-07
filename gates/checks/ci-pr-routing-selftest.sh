#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='ci-pr-routing-selftest'
GATE_NAME='PR Quality and Case Smoke routing regression'
GATE_COMMAND='node --test scripts/ci/quality-scope.test.mjs'
GATE_SUCCESS='changed-path and Case routing preserve required Gates and fail-closed selection'
GATE_FAILURE='PR CI may drop a required Gate, run heavy fixture-only checks, or skip an eligible Case'
GATE_REPAIR='repair scripts/ci/quality-scope.mjs and owning workflow routes'
GATE_OWNER='scripts/ci/quality-scope.mjs + .github/workflows/ci-quality.yml + .github/workflows/acceptance-case-smoke.yml'
gate_check() {
  gate_require_command node "Install Node.js 24 and rerun." || return $?
  gate_run_invariant node --test scripts/ci/quality-scope.test.mjs
}
gate_main "$@"
