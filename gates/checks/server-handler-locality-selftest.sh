#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='server-handler-locality-selftest'
GATE_NAME='Server Handler locality detector mutations'
GATE_COMMAND='node scripts/server-handler-locality.mjs --self-test'
GATE_SUCCESS='the Server route/handler checker rejects known locality and version violations'
GATE_FAILURE='the Server handler locality checker stopped catching a declared violation'
GATE_REPAIR='repair scripts/server-handler-locality.mjs and canonical Server handler ownership; do not suppress a mutation'
GATE_OWNER='scripts/server-handler-locality.mjs + crates/nession-server/src/server/handler'
gate_check() {
  gate_require_command node "Install Node.js and rerun the locality fixture." || return $?
  gate_run_invariant node scripts/server-handler-locality.mjs --self-test
}
gate_main "$@"
