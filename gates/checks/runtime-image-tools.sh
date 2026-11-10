#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='runtime-image-tools'
GATE_NAME='Runtime image EROFS tool packaging'
GATE_COMMAND='node scripts/runtime-image-tools.mjs'
GATE_SUCCESS='both Server and both Agent final images carry the pinned EROFS build/mount tools; the UI image carries none'
GATE_FAILURE='a final runtime image lost a required EROFS tool or the two packaging paths drifted'
GATE_REPAIR='restore the shared erofs-utils-builder/runtime-tools stages in all four Dockerfiles; do not add runtime tooling to the UI image'
GATE_OWNER='scripts/runtime-image-tools.mjs + Dockerfile.{server,agent}{,.prebuilt} + deploy/build-erofs-utils.sh'

gate_check() {
  gate_require_command node "Install Node.js to run the runtime image packaging guard." || return $?
  gate_run_invariant node scripts/runtime-image-tools.mjs
}

gate_main "$@"
