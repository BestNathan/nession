#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='ci-trigger-scope-selftest'
GATE_NAME='CI PR path trigger and Quality job-selection regression fixtures'
GATE_COMMAND='node scripts/ci-trigger-scope-selftest.mjs'
GATE_SUCCESS='Rust/Web/E2E/Case/Scenario routing matches actual YAML and Quality selector'
GATE_FAILURE='CI route incorrectly starts or omits a check for known changed-file fixtures'
GATE_REPAIR='repair the owning workflow trigger or exact-diff classifier, not a second router'
GATE_OWNER='scripts/ci-trigger-scope-selftest.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the CI trigger fixture Gate." || return $?
  gate_run_invariant node scripts/ci-trigger-scope-selftest.mjs
}
gate_main "$@"
