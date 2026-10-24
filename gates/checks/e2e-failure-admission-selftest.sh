#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-failure-admission-selftest'
GATE_NAME='E2E duplicate-failure fingerprint and pre-Agent admission'
GATE_COMMAND='node scripts/e2e-failure-admission.mjs self-test'
GATE_SUCCESS='repeat observations reuse the existing analysis while independent failures remain distinct'
GATE_FAILURE='same-error duplicate analysis or a distinct failure was falsely suppressed'
GATE_REPAIR='repair scripts/e2e-failure-admission.mjs; do not bypass the negative fixtures'
GATE_OWNER='scripts/e2e-failure-admission.mjs'

gate_check() {
  gate_require_command node "Install Node.js to test the E2E Agent admission policy." || return $?
  gate_run_invariant node scripts/e2e-failure-admission.mjs self-test
}

gate_main "$@"
