#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='release-version-consistency-selftest'
GATE_NAME='Release version consistency detector contract'
GATE_COMMAND='bash scripts/release-version-consistency-selftest.sh'
GATE_SUCCESS='matching versions pass, mismatches fail, unreadable inputs error'
GATE_FAILURE='the release version detector stopped rejecting mismatch or unreadable input'
GATE_REPAIR='fix the canonical release-version-consistency Gate without weakening mismatch/error handling'
GATE_OWNER='gates/checks/release-version-consistency.sh + scripts/release-version-consistency-selftest.sh'
gate_check() {
  gate_require_command node "Install Node.js and rerun the version self-test." || return $?
  gate_run_invariant bash scripts/release-version-consistency-selftest.sh
}
gate_main "$@"
