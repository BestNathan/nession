#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='run-store-inventory'
GATE_NAME='Trusted orphan Store writer and source dependency inventory'
GATE_COMMAND='node scripts/metrics-replay-source.mjs self-test && node scripts/run-store-inventory.mjs self-test && node scripts/run-store-inventory.mjs check && node scripts/run-store-policy.mjs self-test && node scripts/run-store-policy.mjs verify-baseline && node scripts/run-store-governance-live.mjs self-test'
GATE_SUCCESS='all Store refs, privileged writers, sources, token origins and dependencies classified'
GATE_FAILURE='unclassified orphan writer/ref/source or unsupported live enforcement assertion'
GATE_REPAIR='update the canonical scripts/run-store-inventory.json and verified producer workflow contract'
GATE_OWNER='scripts/run-store-inventory.mjs'
gate_check() {
  gate_require_command node "Install Node.js and rerun orphan Store Inventory Gate." || return $?
  gate_run_invariant node scripts/metrics-replay-source.mjs self-test &&
  gate_run_invariant node scripts/run-store-inventory.mjs self-test &&
    gate_run_invariant node scripts/run-store-inventory.mjs check &&
    gate_run_invariant node scripts/run-store-policy.mjs self-test &&
    gate_run_invariant node scripts/run-store-policy.mjs verify-baseline &&
    gate_run_invariant node scripts/run-store-governance-live.mjs self-test
}
gate_main "$@"
