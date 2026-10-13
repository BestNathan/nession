#!/usr/bin/env bash
set -euo pipefail
GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='issue-e2e-assertion-evidence-selftest'
GATE_NAME='Executed Playwright expectation evidence is authenticated and counted'
GATE_COMMAND='node scripts/issue-e2e-assertion-reporter-selftest.cjs && node e2e/runner/selected-report.mjs self-test && node scripts/issue-e2e-collect.mjs self-test'
GATE_SUCCESS='selected E2E results cannot fake nonzero expect count from default JSON'
GATE_FAILURE='missing or mismatched assertion evidence may be marked Pass'
GATE_REPAIR='repair trusted reporter, classifier and collection negative fixtures'
GATE_OWNER='scripts/issue-e2e-assertion-reporter.cjs + e2e/runner/selected-report.mjs'

gate_check() {
  gate_require_command node "Install Node.js before running Issue E2E assertion evidence selftests." || return $?
  gate_run_invariant bash -c 'node scripts/issue-e2e-assertion-reporter-selftest.cjs && node e2e/runner/selected-report.mjs self-test && node scripts/issue-e2e-collect.mjs self-test'
}
gate_main "$@"
