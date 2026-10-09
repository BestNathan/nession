#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='requirement-acceptance-selftest'
GATE_NAME='Requirement acceptance validator contract'
GATE_COMMAND='node scripts/requirement-acceptance.mjs self-test'
GATE_SUCCESS='requirement acceptance parser/gate fixtures pass'
GATE_FAILURE='requirement acceptance validation failed its deterministic fixtures'
GATE_REPAIR='fix the validator/fixture without weakening Success Criteria or Acceptance Report semantics'
GATE_OWNER='scripts/requirement-acceptance.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/requirement-acceptance.mjs self-test
}

gate_main "$@"
