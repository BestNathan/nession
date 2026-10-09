#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='requirement-acceptance-pre-merge'
GATE_NAME='Requirement pre-merge acceptance guard'
GATE_COMMAND='node scripts/requirement-acceptance.mjs pre-merge-pr-gate'
GATE_SUCCESS='every requirement implemented by the PR has accepted pre-merge criteria'
GATE_FAILURE='a requirement implemented by the PR does not satisfy its pre-merge acceptance criteria'
GATE_REPAIR='fix the implementation or acceptance evidence, rerun pre-merge Acceptance, keep the blocked PR open for further work'
GATE_OWNER='scripts/requirement-acceptance.mjs + GitHub requirement issue state'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_require_env GITHUB_TOKEN "Provide a GitHub token with the permissions required by the acceptance workflow." || return $?
  gate_require_env GITHUB_EVENT_PATH "Run this gate from the matching GitHub event context or provide GITHUB_EVENT_PATH." || return $?
  gate_run_invariant node scripts/requirement-acceptance.mjs pre-merge-pr-gate
}

gate_main "$@"
