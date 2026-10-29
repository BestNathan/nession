#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd -P)"
source "\${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-event-relay-selftest'
GATE_NAME='Durable source-authenticated Acceptance shadow inbox'
GATE_COMMAND='node scripts/acceptance-event-relay-selftest.mjs'
GATE_SUCCESS='HMAC/source binding, SC eligibility, SQLite CAS/restart, ambiguous-delivery and negative cases pass'
GATE_FAILURE='unverified event, duplicate claim or unsafe crash/timeout recovery'
GATE_REPAIR='repair scripts/acceptance-event-relay-{core,relay}.mjs and negative fixtures; preserve legacy wakers'
GATE_OWNER='scripts/acceptance-event-relay-core.mjs + scripts/acceptance-event-relay.mjs'
gate_check() {
  gate_require_command node "Install Node.js 24 or newer." || return $?
  gate_require_path './scripts/acceptance-event-relay-selftest.mjs' "Restore shadow event relay fixtures." || return $?
  gate_run_invariant node scripts/acceptance-event-relay-selftest.mjs
}
gate_main "$@"
