#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
source "$GATE_DIR/../lib/common.sh"
GATE_ID='acceptance-postrun-waker-selftest'
GATE_NAME='Post-run E2E wake source authentication and replay contract'
GATE_COMMAND='node scripts/acceptance-postrun-waker-selftest.mjs'
GATE_SUCCESS='canonical Waker jq identity/auth, negative events, git ancestry, and shared Agent updater fixtures pass'
GATE_FAILURE='post-run E2E completion wake trusts an unverified source or breaks existing trigger invariants'
GATE_REPAIR='repair the exact production Waker auth policy and its fixtures without weakening SHA/run/attempt/ancestry checks'
GATE_OWNER='scripts/acceptance-postrun-waker-selftest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to verify Acceptance Waker." || return $?
  gate_require_command git "Install Git to verify SHA ancestry." || return $?
  gate_require_command jq "Install jq to execute the production Waker policy." || return $?
  gate_require_path './scripts/acceptance-postrun-waker-selftest.mjs' "Restore the Waker selftest." || return $?
  gate_require_path './.github/workflows/acceptance-postrun-waker.yml' "Restore the trusted Waker workflow." || return $?
  gate_run_invariant node scripts/acceptance-postrun-waker-selftest.mjs || return $?
  gate_run_invariant node scripts/acceptance-dependency-state.mjs self-test
}
gate_main "$@"
