#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"
GATE_ID='gate-consumer-parity'
GATE_NAME='Quality consumer migration and parity contract'
GATE_COMMAND='node scripts/gate-consumer-parity.mjs'
GATE_SUCCESS='all audited quality consumers still select their canonical Gates'
GATE_FAILURE='a workflow/Justfile lost a blocking Gate or reintroduced a raw self-test shadow'
GATE_REPAIR='restore the intended Gate ID in the corresponding consumer and retain the original domain rule owner'
GATE_OWNER='scripts/gate-consumer-parity.mjs + .github/workflows + justfile'
gate_check() {
  gate_require_command node "Install Node.js and rerun parity contract." || return $?
  gate_run_invariant node scripts/gate-consumer-parity.mjs
}
gate_main "$@"
