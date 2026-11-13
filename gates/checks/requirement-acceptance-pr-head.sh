#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='requirement-acceptance-pr-head'
GATE_NAME='Requirement PR acceptance guard'
GATE_COMMAND='node scripts/requirement-acceptance.mjs pr-acceptance-gate'
GATE_SUCCESS='every requirement implemented by the PR has accepted PR criteria'
GATE_FAILURE='a requirement implemented by the PR does not satisfy its PR acceptance criteria'
GATE_REPAIR='fix the implementation or acceptance evidence, rerun PR Acceptance, keep the blocked PR open for further work'
GATE_OWNER='scripts/requirement-acceptance.mjs + GitHub requirement issue state'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_env GITHUB_TOKEN "Provide a GitHub token with the permissions required by the acceptance workflow." || return $?
  gate_require_env GITHUB_EVENT_PATH "Run this gate from the matching GitHub event context or provide GITHUB_EVENT_PATH." || return $?
  gate_run_invariant node scripts/requirement-acceptance.mjs pr-acceptance-gate
}

gate_main "$@"
