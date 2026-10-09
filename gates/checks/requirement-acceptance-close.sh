#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='requirement-acceptance-close'
GATE_NAME='Requirement acceptance close guard'
GATE_COMMAND='node scripts/requirement-acceptance.mjs issue-close-guard'
GATE_SUCCESS='the closed requirement has closure-eligible Acceptance evidence'
GATE_FAILURE='the closed requirement does not satisfy the acceptance contract'
GATE_REPAIR='complete the missing Acceptance evidence/status and rerun the close guard'
GATE_OWNER='scripts/requirement-acceptance.mjs + GitHub requirement issue state'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_env GITHUB_TOKEN "Provide a GitHub token with the permissions required by the acceptance workflow." || return $?
  gate_require_env GITHUB_EVENT_PATH "Run this gate from the matching GitHub event context or provide GITHUB_EVENT_PATH." || return $?
  gate_run_invariant node scripts/requirement-acceptance.mjs issue-close-guard
}

gate_main "$@"
