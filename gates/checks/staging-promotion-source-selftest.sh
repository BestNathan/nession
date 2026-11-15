#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='staging-promotion-source-selftest'
GATE_NAME='Authenticated Staging promotion E2E source and stale-webhook ancestry'
GATE_COMMAND='node scripts/staging-convergence-pr.mjs self-test'
GATE_SUCCESS='legitimate immutable bot promotions pass; stale/forged bases, source pins and removed tests are rejected'
GATE_FAILURE='native promotion source planner accepted a forged base or rejected verified live Main ancestry'
GATE_REPAIR='repair scripts/staging-convergence-pr.mjs source validation and isolated negative fixtures; never bypass ingest provenance'
GATE_OWNER='scripts/staging-convergence-pr.mjs'

gate_check() {
  gate_require_command node 'Install Node.js for the native promotion source fixture.' || return $?
  gate_require_command git 'Install Git to verify authenticated source commit ancestry.' || return $?
  gate_run_invariant node scripts/staging-convergence-pr.mjs self-test
}

gate_main "$@"
