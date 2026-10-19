#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='agent-checkpoint-store'
GATE_NAME='Encrypted Agent checkpoint Store integrity'
GATE_COMMAND='node scripts/lib/agent/store/ingest-selftest.mjs && node scripts/lib/agent/store/remote-selftest.mjs && node scripts/lib/agent/providers/claude-store-remote-selftest.mjs && node scripts/lib/agent/orchestration/controller-start-selftest.mjs'
GATE_SUCCESS='encrypted checkpoint provenance, Controller origin-commit replay, append-only CAS and restore fixtures pass'
GATE_FAILURE='checkpoint authentication, provenance, CAS or restoration invariant failed'
GATE_REPAIR='fix checkpoint Store contract without bypassing ciphertext authentication or concurrency'
GATE_OWNER='scripts/lib/agent/store/ingest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run provider contract fixtures." || return $?
  gate_run_invariant node scripts/lib/agent/store/ingest-selftest.mjs && node scripts/lib/agent/store/remote-selftest.mjs && node scripts/lib/agent/providers/claude-store-remote-selftest.mjs && node scripts/lib/agent/orchestration/controller-start-selftest.mjs
}
gate_main "$@"
