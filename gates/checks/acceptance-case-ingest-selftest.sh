#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='acceptance-case-ingest-selftest'
GATE_NAME='acceptance case ingest selftest'
GATE_COMMAND='node scripts/acceptance-case-ingest.mjs self-test && node e2e/acceptance/cases/1828/SC-01/verify.js --self-test'
GATE_SUCCESS='canonical Case Ingest contract and live Case source/writer/consumer security negative fixtures pass'
GATE_FAILURE='canonical acceptance-case-ingest-selftest invariant or fixture failed'
GATE_REPAIR='fix scripts/acceptance-case-ingest.mjs and its fixtures; do not bypass the detection'
GATE_OWNER='scripts/acceptance-case-ingest.mjs'
gate_check() {
  gate_require_command node "Install Node.js to evaluate this Gate." || return $?
  gate_require_path './scripts/acceptance-case-ingest.mjs' "Restore scripts/acceptance-case-ingest.mjs." || return $?
  gate_run_invariant node scripts/acceptance-case-ingest.mjs self-test || return $?
  gate_require_path './e2e/acceptance/cases/1828/SC-01/verify.js' "Restore the #1828 source identity and trusted-pipeline verifier." || return $?
  gate_run_invariant node e2e/acceptance/cases/1828/SC-01/verify.js --self-test
}
gate_main "$@"
