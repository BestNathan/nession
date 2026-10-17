#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='web-build-artifact-selftest'
GATE_NAME='Exact-SHA Web build artifact integrity'
GATE_COMMAND='node scripts/ci/web-build-artifact.mjs self-test'
GATE_SUCCESS='Web dist restore enforces SHA, producer, env, checksums and font licenses'
GATE_FAILURE='Web build artifact integrity positive or negative fixture failed'
GATE_REPAIR='fix scripts/ci/web-build-artifact.mjs and its cases without bypassing the checks'
GATE_OWNER='scripts/ci/web-build-artifact.mjs'
gate_check() {
  gate_require_command node "Install Node.js to run the Web artifact Gate." || return $?
  gate_require_command npm "Install npm for version-bound artifact tests." || return $?
  gate_require_command git "Install Git for source identity tests." || return $?
  gate_require_path './scripts/ci/web-build-artifact.mjs' "Restore the Web artifact owner." || return $?
  gate_run_invariant node scripts/ci/web-build-artifact.mjs self-test
}
gate_main "$@"
