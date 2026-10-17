#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-playwright'
GATE_NAME='End-to-end browser tests'
GATE_COMMAND='cd e2e && CI=true ./run test --all'
GATE_SUCCESS='the full Nession Playwright E2E suite passes'
GATE_FAILURE='one or more browser E2E scenarios failed'
GATE_REPAIR='inspect e2e/playwright-report and test-results, fix the failing runtime/UI behavior, and rerun the gate'
GATE_OWNER='e2e/ Playwright suite + runtime surfaces'

gate_check() {
  gate_require_command cargo "Install the repository Rust toolchain and rerun the gate." || return $?
  gate_require_command tmux "Install tmux; nession-agent requires it for E2E sessions." || return $?
  gate_require_command npx "Install Node/npm tooling and rerun the gate." || return $?
  gate_require_path "./e2e/node_modules" "Run `cd e2e && npm install` and install Chromium before this gate." || return $?
  gate_require_path "./web/dist" "Run `cd web && npm run build` before the E2E gate." || return $?
  gate_require_command node "Install Node.js and rerun the E2E gate." || return $?
  gate_require_path "./e2e/run" "Restore the canonical E2E runner." || return $?
  local list_file="${RUNNER_TEMP:-/tmp}/e2e-playwright-list-${GITHUB_RUN_ID:-local}.txt"
  local full_report="${E2E_PLAYWRIGHT_REPORT_FILE:-${RUNNER_TEMP:-/tmp}/e2e-playwright-full-${GITHUB_RUN_ID:-local}.json}"
  local assertions="${E2E_PLAYWRIGHT_ASSERTIONS_FILE:-${full_report%.json}-assertions.json}"
  local provision_log="${RUNNER_TEMP:-/tmp}/e2e-playwright-provisions-${GITHUB_RUN_ID:-local}.jsonl"
  # #1876 Phase A: the independent Browser Design verdict is derived from these
  # exact files after this Gate returns. They are part of this Gate's evidence,
  # so a missing pair fails here too rather than leaving the next step to
  # discover an empty directory.
  if [[ "$full_report" != /* || "$assertions" != /* ]]; then
    gate_runtime_error "Full E2E report paths must be absolute" \
      "set E2E_PLAYWRIGHT_REPORT_FILE and E2E_PLAYWRIGHT_ASSERTIONS_FILE to absolute paths" || return $?
  fi
  rm -f "$full_report" "$assertions"
  : > "$provision_log"
  # Playwright list-only discovery has no full-stack startup; verify it matches file-ID catalog.
  gate_run_invariant bash -c 'cd e2e && npx playwright test --list > "$1"' _ "$list_file"
  gate_run_invariant node e2e/runner/verify-playwright-list.cjs "$list_file"
  # #1866 SC-03: this Gate used to provision the real full stack TWICE — a
  # two-ID canary run, then `--all`. Selection is a pure ID -> spec-file
  # mapping, so its positive and negative contract is verified without a
  # runtime, and each canary ID's REAL outcome is verified per ID from the one
  # full run below. The subset runtime path keeps live coverage on every
  # selected PR run, which invokes `./e2e/run test --id …` for real.
  gate_run_invariant node e2e/runner/verify-e2e-selector.cjs login session-lifecycle
  # Exactly one full-stack provision for this Gate invocation. Measured, not
  # assumed: the shared runtime appends one line per real provision.
  gate_run_invariant bash -c 'cd e2e && CI=true E2E_RUNTIME_PROVISION_LOG="$3" PLAYWRIGHT_JSON_OUTPUT_FILE="$1" NESSION_E2E_ASSERTIONS_OUTPUT_FILE="$2" ./run test --all' _ "$full_report" "$assertions" "$provision_log"
  if [ ! -s "$full_report" ] || [ ! -s "$assertions" ]; then
    gate_invariant_failure "Full E2E did not produce the report and assertion receipt required for an independent design verdict" \
      "restore the canonical Playwright reporters; a run without executed assertion evidence is not a Pass" || return $?
  fi
  gate_run_invariant bash -c '
    count=$(wc -l < "$1" | tr -d " ")
    if [ "$count" -ne 1 ]; then
      echo "one Gate invocation must provision the full stack exactly once; observed ${count}" >&2
      exit 1
    fi' _ "$provision_log"
  # Legacy selector/canary assurance retained against that single run: a canary
  # ID that did not run, was skipped, or did not fully pass still fails here.
  gate_run_invariant node e2e/runner/verify-playwright-selected.cjs "$full_report" login session-lifecycle
  # #1866 Measurements: bounded, non-sensitive gate evidence. The Gate's own
  # command output is intentionally discarded on success, so the measured
  # provision count would otherwise be unobservable after the fact.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'e2e-playwright: mode=full full_stack_provisions=%s sha=%s\n' \
      "$(wc -l < "$provision_log" | tr -d ' ')" "${GITHUB_SHA:-unknown}" \
      >> "$GITHUB_STEP_SUMMARY"
  fi
  # #1866 SC-03: the Acceptance harness compacts evidence to run metadata and
  # never reads artifacts or step summaries. Emit the measured facts into the
  # job log so a trusted collector can attest at-most-one provision and the
  # retained selector/canary assurance at the exact push SHA.
  if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    # `gates/run` captures the Gate's own output, so the workflow passes an
    # absolute file path and prints it after the Gate returns.
    if [ -n "${E2E_PROVISION_RECEIPT_FILE:-}" ]; then
      case "$E2E_PROVISION_RECEIPT_FILE" in
        /*) ;;
        *) echo "E2E_PROVISION_RECEIPT_FILE must be absolute" >&2; return 1 ;;
      esac
      mkdir -p "$(dirname "$E2E_PROVISION_RECEIPT_FILE")"
    fi
    gate_run_invariant node -e '
      const provisions = Number(process.argv[1]);
      const sha = String(process.argv[2] || "");
      const runId = Number(process.env.GITHUB_RUN_ID);
      const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
      if (!/^[0-9a-f]{40}$/.test(sha) || provisions !== 1 ||
          !Number.isSafeInteger(runId) || runId < 1 ||
          !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
        console.error("full Gate receipt requires an exact SHA, one provision and a run identity");
        process.exit(1);
      }
      const line = "E2E_FULL_GATE_PROVISION_V1 " + JSON.stringify({
        schema_version: 1, kind: "e2e_full_gate",
        repository: process.env.GITHUB_REPOSITORY, workflow: ".github/workflows/e2e-tests.yml",
        run_id: runId, run_attempt: runAttempt, sha, mode: "all", provisions,
        selector_verified: true, selected_report_verified: true,
      }) + "\n";
      process.stdout.write(line);
      const receiptFile = String(process.argv[3] || "");
      if (receiptFile) require("node:fs").writeFileSync(receiptFile, line);
    ' "$(wc -l < "$provision_log" | tr -d ' ')" "${GITHUB_SHA:-}" \
      "${E2E_PROVISION_RECEIPT_FILE:-}"
  fi
}

gate_main "$@"
