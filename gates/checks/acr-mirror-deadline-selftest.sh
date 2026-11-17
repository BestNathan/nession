#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acr-mirror-deadline-selftest'
GATE_NAME='Authenticated GHCR source and bounded ACR mirror login and uploads'
GATE_COMMAND='node scripts/ci/verify-staging-ghcr-source.mjs self-test && node --test scripts/mirror-container-images.test.mjs scripts/acr-registry-login.test.mjs'
GATE_SUCCESS='bounded ACR login rejects credentials without retrying, transport retries are sanitized, two-platform digest verification remains strict and expired uploads fail closed'
GATE_FAILURE='unsafe or unbounded ACR auth/upload retry, HTTP/2 drift or incomplete/mismatched mirror can be accepted as release evidence'
GATE_REPAIR='fix scripts/ci/acr-registry-login.sh, scripts/mirror-container-images.sh and their isolated fixtures; never bypass source-destination manifest checks'
GATE_OWNER='scripts/mirror-container-images.sh'

gate_check() {
  gate_require_command node 'Install Node.js to execute the ACR mirror deadline fixture.' || return $?
  gate_run_invariant bash -c 'node scripts/ci/verify-staging-ghcr-source.mjs self-test && node --test scripts/mirror-container-images.test.mjs scripts/acr-registry-login.test.mjs'
}

gate_main "$@"
