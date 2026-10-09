#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-audit-agent-selftest'
GATE_NAME='Issue audit agent contract'
GATE_COMMAND='node scripts/issue-audit-agent.mjs self-test'
GATE_SUCCESS='issue audit agent self-tests pass'
GATE_FAILURE='the issue audit agent harness failed its deterministic self-test'
GATE_REPAIR='fix the audit harness/provider-independent behavior before enabling issue audit'
GATE_OWNER='scripts/issue-audit-agent.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  gate_run_invariant node scripts/issue-audit-agent.mjs self-test
}

gate_main "$@"
