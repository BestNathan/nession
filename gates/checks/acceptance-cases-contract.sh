#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='acceptance-cases-contract'
GATE_NAME='Acceptance Cases tooling contract'
GATE_COMMAND='node scripts/acceptance-cases-selftest.mjs && node scripts/acceptance-executor.mjs self-test && node scripts/acceptance-case-ingest.mjs self-test'
GATE_SUCCESS='Case discovery/schema, executor, and trusted ingestion fixtures pass'
GATE_FAILURE='the canonical Acceptance Case contract failed its deterministic fixtures'
GATE_REPAIR='fix source-aligned Case discovery, executor, or trusted ingest; do not bypass negative fixtures'
GATE_OWNER='scripts/acceptance-cases-selftest.mjs + scripts/acceptance-executor.mjs + scripts/acceptance-case-ingest.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  
  gate_run_invariant bash -c 'node scripts/acceptance-cases-selftest.mjs && node scripts/acceptance-executor.mjs self-test && node scripts/acceptance-case-ingest.mjs self-test'
}

gate_main "$@"
