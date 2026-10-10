#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='server-handler-locality'
GATE_NAME='Server handler semantic locality'
GATE_COMMAND='node scripts/server-handler-locality.mjs'
GATE_SUCCESS='each versioned Server Unit resolves to one leaf and one canonical route declaration'
GATE_FAILURE='route identity, implementation path, version, control or relay ownership is inconsistent'
GATE_REPAIR='repair routes.rs and the matching versioned handler module; do not duplicate manifests or fake relay handlers'
GATE_OWNER='scripts/server-handler-locality.mjs + crates/nession-server/src/server/handler'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/server-handler-locality.mjs
}

gate_main "$@"
