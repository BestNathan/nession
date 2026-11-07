#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='gate-router-contract'
GATE_NAME='Git hook Gate routing contract'
GATE_COMMAND='node scripts/gate-router-selftest.mjs'
GATE_SUCCESS='the live hook suites and central router select required Gates; unverifiable diffs cannot silently skip checks'
GATE_FAILURE='pre-commit/pre-push routing lost a required Gate or owner negative fixture'
GATE_REPAIR='repair gates/route or stage suite membership; rerun deterministic routing fixtures without bypassing'
GATE_OWNER='gates/route + gates/suites/pre-*.gates + scripts/gate-router-selftest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run deterministic hook fixtures." || return $?
  gate_run_invariant node scripts/gate-router-selftest.mjs
}
gate_main "$@"
