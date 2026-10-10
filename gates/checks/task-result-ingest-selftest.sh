#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='task-result-ingest-selftest'
GATE_NAME='task result ingest selftest'
GATE_COMMAND='node scripts/task-result-ingest.mjs self-test'
GATE_SUCCESS='canonical task-result-ingest-selftest contract passes its checks'
GATE_FAILURE='canonical task-result-ingest-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/task-result-ingest.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/task-result-ingest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/task-result-ingest.mjs' "Restore scripts/task-result-ingest.mjs." || return $?
  gate_run_invariant node scripts/task-result-ingest.mjs self-test
}
gate_main "$@"
