#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='runtime-image-tools-selftest'
GATE_NAME='Runtime image EROFS tool packaging detector contract'
GATE_COMMAND='node scripts/runtime-image-tools.mjs --self-test'
GATE_SUCCESS='the packaging guard accepts the shared baseline and rejects every known regression mutation'
GATE_FAILURE='a known runtime-image packaging regression escaped the guard'
GATE_REPAIR='restore the guard detection; never weaken the Dockerfile packaging contract to make it pass'
GATE_OWNER='scripts/runtime-image-tools.mjs --self-test'

gate_check() {
  gate_require_command node "Install Node.js to run the packaging guard self-test." || return $?
  gate_run_invariant node scripts/runtime-image-tools.mjs --self-test
}

gate_main "$@"
