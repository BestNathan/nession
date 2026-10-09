#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='requirement-acceptance-pr'
GATE_NAME='Requirement acceptance PR guard'
GATE_COMMAND='node scripts/requirement-acceptance.mjs pr-gate'
GATE_SUCCESS='every requirement closed by the PR has merge-eligible Acceptance evidence'
GATE_FAILURE='a requirement affected by the PR does not satisfy the acceptance contract'
GATE_REPAIR='complete/update the requirement Acceptance Report and Success Criteria evidence; do not bypass the guard'
GATE_OWNER='scripts/requirement-acceptance.mjs + GitHub requirement issue state'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_env GITHUB_TOKEN "Provide a GitHub token with the permissions required by the acceptance workflow." || return $?
  gate_require_env GITHUB_EVENT_PATH "Run this gate from the matching GitHub event context or provide GITHUB_EVENT_PATH." || return $?
  gate_run_invariant node scripts/requirement-acceptance.mjs pr-gate
}

gate_main "$@"
