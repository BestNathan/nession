#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='workflow-conventions'
GATE_NAME='GitHub Actions workflow taxonomy and reference integrity'
GATE_COMMAND='node scripts/workflow-conventions.mjs self-test && node scripts/workflow-conventions.mjs check'
GATE_SUCCESS='all workflows are classified and workflow_run/reusable references remain resolvable'
GATE_FAILURE='an unclassified workflow, incorrect domain, stale trigger/reference or telemetry source path was found'
GATE_REPAIR='follow nession-workflows; migrate all upstream names, file paths and telemetry provenance as one tested boundary'
GATE_OWNER='scripts/workflow-conventions.mjs'

gate_check() {
  gate_require_command node "Install Node.js to verify GitHub Actions workflow contracts." || return $?
  gate_run_invariant bash -c 'node scripts/workflow-conventions.mjs self-test && node scripts/workflow-conventions.mjs check'
}
gate_main "$@"
