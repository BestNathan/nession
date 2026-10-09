#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='instruction-contract'
GATE_NAME='Repository instruction contract'
GATE_COMMAND='node --test scripts/instruction-contract.test.mjs && node scripts/instruction-contract.mjs'
GATE_SUCCESS='repository instructions preserve canonical ownership, compatibility links, and context budgets'
GATE_FAILURE='the repository instruction graph violates its ownership, compatibility, metadata, or context-budget contract'
GATE_REPAIR='restore the canonical AGENTS/CLAUDE/Skill layout or move oversized guidance to scoped owners/docs/references'
GATE_OWNER='scripts/instruction-contract.mjs + docs/engineering/instruction-architecture.md'

gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?
  if node --test scripts/instruction-contract.test.mjs && node scripts/instruction-contract.mjs; then
    return 0
  fi
  gate_invariant_failure "$GATE_FAILURE" "$GATE_REPAIR"
}

gate_main "$@"
