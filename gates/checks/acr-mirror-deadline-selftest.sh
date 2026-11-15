#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acr-mirror-deadline-selftest'
GATE_NAME='Bounded authenticated ACR mirror uploads and expiry failures'
GATE_COMMAND='node --test scripts/mirror-container-images.test.mjs'
GATE_SUCCESS='a bounded two-platform mirror validates both digests and expired uploads fail closed after three tries'
GATE_FAILURE='unbounded uploads or incomplete/mismatched mirror can be accepted as release evidence'
GATE_REPAIR='fix scripts/mirror-container-images.sh and its Docker/timeout fixtures; never bypass source-destination manifest checks'
GATE_OWNER='scripts/mirror-container-images.sh'

gate_check() {
  gate_require_command node 'Install Node.js to execute the ACR mirror deadline fixture.' || return $?
  gate_run_invariant node --test scripts/mirror-container-images.test.mjs
}

gate_main "$@"
