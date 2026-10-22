#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='design-system-browser'
GATE_NAME='Design system (browser)'
GATE_COMMAND='node design/scripts/design-gate.mjs --profile browser'
GATE_SUCCESS='the canonical design-system browser profile passes with authenticated per-test evidence'
GATE_FAILURE='one or more canonical design-system browser profile rules failed or its evidence is unproven'
GATE_REPAIR='follow the design gate owner/repair diagnostics; fix the canonical design source or consumer instead of bypassing the rule'
GATE_OWNER='design/scripts/design-gate.mjs + design/scripts/browser-design-catalog.mjs + canonical design sources'

# #1876 Phase A: on Full/Selected E2E the canonical browser specs already ran
# inside the single canonical Playwright process. This Gate then derives its
# OWN verdict from that run's JSON report and assertion receipt instead of
# launching a second Playwright process. Verification is fail-closed: absent,
# corrupt, foreign-SHA, skipped, flaky, zero-assertion or list-drifted evidence
# is a Gate failure, never an implicit Pass.
gate_check() {
  gate_require_command node "Install Node.js and rerun the gate." || return $?

  if [ -n "${DESIGN_BROWSER_REPORT:-}" ]; then
    local report="$DESIGN_BROWSER_REPORT"
    local assertions="${DESIGN_BROWSER_ASSERTIONS:-}"
    local sha="${DESIGN_BROWSER_SHA:-${NESSION_TARGET_SHA:-}}"
    if [[ "$report" != /* || "$assertions" != /* ]]; then
      gate_runtime_error "coalesced design verification requires absolute report and assertion paths" \
        "set DESIGN_BROWSER_REPORT and DESIGN_BROWSER_ASSERTIONS to the Full E2E run's evidence files" || return $?
    fi
    if [ -z "$sha" ] || [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
      gate_runtime_error "coalesced design verification requires an exact target SHA" \
        "set DESIGN_BROWSER_SHA or NESSION_TARGET_SHA to the checked-out 40-character SHA" || return $?
    fi
    local -a verify_args=(--profile browser --verify-report "$report" --assertions "$assertions" --sha "$sha")
    if [ -n "${DESIGN_BROWSER_RECEIPT_FILE:-}" ]; then
      verify_args+=(--receipt "$DESIGN_BROWSER_RECEIPT_FILE")
    fi
    gate_run_invariant node design/scripts/design-gate.mjs "${verify_args[@]}"
    return $?
  fi

  gate_require_path "./web/node_modules" "Run `cd web && npm install` before this gate." || return $?
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./e2e/node_modules" "Run `cd e2e && npm install` before this gate." || return $?
  gate_run_invariant node design/scripts/design-gate.mjs --profile browser
}

gate_main "$@"
