#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-event-consumer-selftest'
GATE_NAME='Trusted source-attested Acceptance event consumer'
GATE_COMMAND='node scripts/acceptance-event-consumer-selftest.mjs'
GATE_SUCCESS='forged or stale sources and plan mismatches never execute Agent; canonical updater reused'
GATE_FAILURE='untrusted external task can invoke privileged Acceptance evaluator'
GATE_REPAIR='repair scripts/acceptance-event-consumer.mjs and main-owned workflow without weakening exact-source checks'
GATE_OWNER='scripts/acceptance-event-consumer.mjs'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-event-consumer-selftest.mjs' "Restore consumer fixtures." || return $?
  gate_run_invariant node scripts/acceptance-event-consumer-selftest.mjs
}
gate_main "$@"
