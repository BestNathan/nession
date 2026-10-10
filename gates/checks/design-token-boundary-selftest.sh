#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='design-token-boundary-selftest'
GATE_NAME='Capsule design token violation fixtures'
GATE_COMMAND='bash scripts/check-design-tokens-selftest.sh'
GATE_SUCCESS='known forbidden capsule metrics fail the canonical ESLint rule while clean baseline passes'
GATE_FAILURE='a forbidden capsule metric was accepted or a failing fixture was not correctly attributed'
GATE_REPAIR='repair the canonical no-capsule-magic-metrics rule and current capsule path; preserve negative fixtures'
GATE_OWNER='scripts/check-design-tokens-selftest.sh + web/eslint-plugin-nession/'
gate_check() {
  gate_require_command node "Install Node.js before running capsule design negative fixtures." || return $?
  gate_require_path "./web/node_modules" "Install Web dependencies before running this Gate." || return $?
  gate_run_invariant bash scripts/check-design-tokens-selftest.sh
}
gate_main "$@"
