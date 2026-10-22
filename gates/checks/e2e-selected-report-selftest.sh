#!/usr/bin/env bash
set -euo pipefail

GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "${GATE_DIR}/../lib/common.sh"

GATE_ID='e2e-selected-report-selftest'
GATE_NAME='Selected Playwright result classifier'
GATE_COMMAND='selected-report CLI/self-test + side-effect-free import + Issue collector self-test'
GATE_SUCCESS='the deterministic E2E contract and negative fixtures pass'
GATE_FAILURE='the selected E2E contract has invalid or falsely accepted inputs'
GATE_REPAIR='repair the canonical source script; do not bypass negative fixtures'
GATE_OWNER='e2e/runner/selected-report.mjs'

gate_check() {
  gate_require_command node "Install Node.js and rerun the E2E contract Gate." || return $?
  gate_run_invariant node e2e/runner/selected-report.mjs self-test
  gate_run_invariant node e2e/runner/e2e-full-per-id-receipt.mjs self-test
  # The real E2E collector imports the reporter while argv[2]='collect'.
  # The reporter must be passive as a library, not run its own CLI.
  gate_run_invariant node --input-type=module -e '
    process.argv=[process.execPath,"scripts/issue-e2e-collect.mjs","collect"];
    const m=await import("./e2e/runner/selected-report.mjs");
    if(typeof m.summarize!=="function")process.exit(1);
    console.log("Selected E2E report: safe imported summarizer");
  '
  gate_run_invariant node scripts/issue-e2e-collect.mjs self-test
  # Two regressions are distinct: the reporter imported by the collector
  # must be passive, and the collector itself must also be import-safe.
  gate_run_invariant node --input-type=module -e '
    process.argv=[process.execPath,"test/harness.mjs","collect"];
    const reporter=await import("./e2e/runner/selected-report.mjs");
    const collector=await import("./scripts/issue-e2e-collect.mjs");
    if(typeof reporter.summarize!=="function"||typeof collector.collect!=="function")process.exit(1);
    try{reporter.summarize(null,null,null);process.exit(1)}
    catch(error){if(!String(error.message).includes("invalid selected E2E plan"))process.exit(1)}
  '
  # Direct CLI input must still fail closed; no accidental success because
  # of the new library import guard.
  if node e2e/runner/selected-report.mjs summarize >/dev/null 2>&1; then
    echo 'reporter CLI accepted missing mandatory files' >&2
    return 1
  fi
  if node e2e/runner/selected-report.mjs unexpected-command >/dev/null 2>&1; then
    echo 'reporter CLI accepted unsupported command' >&2
    return 1
  fi
}

gate_main "$@"
