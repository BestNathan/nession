#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='e2e-run-ingest-negative-selftest'
GATE_NAME='e2e run ingest negative selftest'
GATE_COMMAND='node scripts/e2e-run-ingest-negative-selftest.mjs'
GATE_SUCCESS='canonical e2e-run-ingest-negative-selftest contract passes its checks'
GATE_FAILURE='canonical e2e-run-ingest-negative-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/e2e-run-ingest-negative-selftest.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/e2e-run-ingest-negative-selftest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/e2e-run-ingest-negative-selftest.mjs' "Restore scripts/e2e-run-ingest-negative-selftest.mjs." || return $?
  gate_run_invariant node scripts/e2e-run-ingest-negative-selftest.mjs
}
gate_main "$@"
