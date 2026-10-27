#!/usr/bin/env node
// #2478 SC-05 / Workstream B: on a Main push where the exact-SHA Full
// Regression is already running for the same merge commit, reuse its verified
// per-ID report for the Issue-selected obligations instead of launching a
// second overlapping browser suite.
//
// This is a fail-closed helper, not an evidence authority: it only locates a
// completed successful `E2E / Full Regression` push run at the exact SHA,
// downloads its immutable artifact, verifies every canonical ID with the
// existing full-receipt owner, and proves every selected ID passed with real
// assertions. Any missing piece exits non-zero so the caller runs the bounded
// selected-suite fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const FULL_WORKFLOW = 'e2e-full-regression.yml';
export const FULL_WORKFLOW_NAME = 'E2E / Full Regression';
const SHA = /^[a-f0-9]{40}$/;
const FULL_RECEIPT_PREFIX = 'E2E_FULL_PER_ID_V1 ';

// gh's JSON uses camelCase; normalize before the decision so a field-name
// mismatch cannot silently turn a real Full run into an endless wait.
export function mapGhRuns(runs) {
  return (Array.isArray(runs) ? runs : []).map((run) => ({
    ...run,
    id: run?.databaseId,
    run_attempt: run?.attempt,
    head_sha: run?.headSha,
  }));
}

// Pure decision over the run list: success wins; a completed unsuccessful
// Full with nothing still running is terminal failure; anything else waits.
export function selectFullState(runs, sha) {
  if (!SHA.test(String(sha)) || !Array.isArray(runs)) return { state: 'absent' };
  const matches = runs.filter((run) =>
    run?.name === FULL_WORKFLOW_NAME &&
    run?.event === 'push' &&
    run?.head_sha === sha);
  if (matches.length === 0) return { state: 'absent' };
  const order = (run) => Number(run.id) || 0;
  const success = matches.filter((run) =>
    run.status === 'completed' && run.conclusion === 'success')
    .sort((a, b) => order(b) - order(a))[0];
  if (success) return { state: 'success', run: success };
  const active = matches.some((run) => run.status !== 'completed');
  if (active) return { state: 'pending' };
  return { state: 'failed' };
}

export function selectCompletedFullRun(runs, sha) {
  const selected = selectFullState(runs, sha);
  return selected.run ?? null;
}

export function parseFullReceipt(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/)
    .filter((line) => line.includes(FULL_RECEIPT_PREFIX));
  if (lines.length !== 1) throw Error('missing or ambiguous Full per-ID receipt');
  const json = lines[0].slice(lines[0].indexOf(FULL_RECEIPT_PREFIX) + FULL_RECEIPT_PREFIX.length);
  const receipt = JSON.parse(json);
  if (receipt?.kind !== 'e2e_full_per_id' || receipt?.status !== 'Pass' ||
      !SHA.test(receipt?.sha ?? '') || !Array.isArray(receipt?.results)) {
    throw Error('invalid Full per-ID receipt');
  }
  return receipt;
}

export function selectedCoverage(receipt, selectedIds) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0 ||
      selectedIds.some((id) => typeof id !== 'string' || !id) ||
      receipt?.sha == null) {
    throw Error('invalid selected coverage input');
  }
  const byId = new Map(receipt.results.map((row) => [row.id, row]));
  const missing = [];
  const unproven = [];
  for (const id of selectedIds) {
    const row = byId.get(id);
    if (!row) { missing.push(id); continue; }
    if (row.result !== 'Pass' || !(row.passed > 0) || row.passed !== row.discovered ||
        row.skipped !== 0 || row.flaky !== 0 || row.failed !== 0 ||
        !(row.assertions > 0)) {
      unproven.push(id);
    }
  }
  return { ok: missing.length === 0 && unproven.length === 0, missing, unproven };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024 });
}

export function findFullRun({ repo, sha, waitSeconds = 900, intervalSeconds = 20,
  sleep = (seconds) => execFileSync('sleep', [String(seconds)]) }) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const runs = mapGhRuns(JSON.parse(gh(['run', 'list', '--repo', repo,
      '--workflow', FULL_WORKFLOW, '--commit', sha, '--event', 'push',
      '--limit', '10',
      '--json', 'databaseId,attempt,name,event,headSha,status,conclusion'])));
    const selected = selectFullState(runs, sha);
    if (selected.state === 'success') return selected.run;
    if (selected.state === 'failed') {
      // A completed unsuccessful Full at the exact SHA is a real release
      // failure; do not mask it by pretending the selected suite replaces it.
      throw Error('exact-SHA Full Regression did not succeed');
    }
    if (Date.now() >= deadline) return null;
    sleep(intervalSeconds);
  }
}

function findNamed(root, name) {
  const matches = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === name) matches.push(full);
    }
  };
  walk(root);
  return matches;
}

function downloadFullArtifact(repo, run) {
  const attempt = Number(run.run_attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw Error('invalid Full run attempt');
  const name = 'full-regression-' + run.id + '-' + attempt;
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'full-reuse-'));
  gh(['run', 'download', String(run.id), '--repo', repo, '--name', name, '--dir', dir]);
  // Artifact paths are relative to the runner temp/work directories, so the
  // receipt files are not necessarily at the extraction root.
  const report = findNamed(dir, 'full-regression-playwright.json');
  const assertions = findNamed(dir, 'full-regression-assertions.json');
  if (report.length !== 1 || assertions.length !== 1) {
    throw Error('Full artifact must contain exactly one report and assertion receipt');
  }
  return { attempt, report: report[0], assertions: assertions[0] };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command !== 'reuse') throw Error('usage: self-test | reuse SHA OUT_DIR SELECTED_IDS_JSON');
  const [sha, outDir, idsJson] = args;
  if (!SHA.test(sha ?? '') || !outDir) throw Error('reuse SHA OUT_DIR SELECTED_IDS_JSON');
  const selectedIds = JSON.parse(idsJson);
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== 'BestNathan/nession') throw Error('unexpected repository');
  const run = findFullRun({ repo, sha });
  if (!run) throw Error('no completed successful exact-SHA Full Regression');
  const { attempt, report, assertions } = downloadFullArtifact(repo, run);
  // Re-verify the downloaded report at the exact SHA. The receipt owner stamps
  // GITHUB_RUN_ID/ATTEMPT, so bind it to the Full run that produced the
  // artifact (the current E2E job's run id is a different run).
  const receipt = parseFullReceipt(execFileSync(process.execPath,
    ['e2e/runner/e2e-full-per-id-receipt.mjs', 'verify', report, assertions, sha],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GITHUB_RUN_ID: String(run.id),
        GITHUB_RUN_ATTEMPT: String(attempt) } }));
  if (receipt.sha !== sha || receipt.run_id !== run.id || receipt.run_attempt !== attempt) {
    throw Error('Full receipt identity mismatch');
  }
  const coverage = selectedCoverage(receipt, selectedIds);
  if (!coverage.ok) {
    throw Error('Full report does not cover the selected IDs: ' +
      JSON.stringify(coverage));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(report, path.join(outDir, 'playwright-run.json'));
  fs.copyFileSync(assertions, path.join(outDir, 'playwright-run-assertions.json'));
  fs.writeFileSync(path.join(outDir, 'reused-full.json'), JSON.stringify({
    run_id: receipt.run_id,
    run_attempt: receipt.run_attempt,
    sha: receipt.sha,
    id_count: receipt.id_count,
    tests: receipt.tests,
    assertions: receipt.assertions,
  }) + '\n');
  process.stdout.write('E2E_SELECTED_REUSED_FULL_V1 ' + JSON.stringify({
    sha: receipt.sha,
    full_run_id: receipt.run_id,
    full_run_attempt: receipt.run_attempt,
    selected_ids: selectedIds.sort(),
    id_count: receipt.id_count,
    tests: receipt.tests,
    assertions: receipt.assertions,
  }) + '\n');
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const run = (over) => ({ id: 10, name: FULL_WORKFLOW_NAME, event: 'push',
    head_sha: sha, status: 'completed', conclusion: 'success', ...over });
  // The real gh JSON shape is camelCase; normalize it before selecting.
  const ghShape = [{ databaseId: 10, attempt: 1, name: FULL_WORKFLOW_NAME,
    event: 'push', headSha: sha, status: 'completed', conclusion: 'success' }];
  assert.equal(selectFullState(mapGhRuns(ghShape), sha).run.id, 10);
  assert.equal(mapGhRuns(ghShape)[0].head_sha, sha);
  assert.equal(mapGhRuns(ghShape)[0].run_attempt, 1);
  assert.equal(selectFullState([run()], sha).run.id, 10);
  assert.equal(selectFullState([run({ event: 'schedule' })], sha).state, 'absent');
  assert.equal(selectFullState([run({ head_sha: 'b'.repeat(40) })], sha).state, 'absent');
  assert.equal(selectFullState([run({ status: 'in_progress', conclusion: null })], sha).state,
    'pending');
  assert.equal(selectFullState([run({ conclusion: 'failure' })], sha).state, 'failed');
  assert.equal(selectFullState([run({ id: 11 }), run({ id: 12 })], sha).run.id, 12);
  assert.equal(selectFullState([run({ conclusion: 'failure' }),
    run({ id: 12, status: 'in_progress', conclusion: null })], sha).state, 'pending');
  assert.equal(selectCompletedFullRun([run()], sha).id, 10);
  assert.equal(selectCompletedFullRun([run({ conclusion: 'failure' })], sha), null);
  const results = (ids) => ids.map((id) => ({ id, result: 'Pass', discovered: 1,
    passed: 1, skipped: 0, flaky: 0, failed: 0, assertions: 2 }));
  const receipt = { kind: 'e2e_full_per_id', status: 'Pass', sha,
    results: results(['alpha', 'beta']) };
  assert.equal(selectedCoverage(receipt, ['alpha']).ok, true);
  assert.deepEqual(selectedCoverage(receipt, ['alpha', 'gamma']).missing, ['gamma']);
  assert.deepEqual(selectedCoverage({ ...receipt,
    results: results(['alpha']).map((row) => ({ ...row, result: 'Fail' })) }, ['alpha']).unproven,
  ['alpha']);
  assert.throws(() => selectedCoverage(receipt, []), /coverage/);
  const line = 'noise\n' + FULL_RECEIPT_PREFIX + JSON.stringify(receipt) + '\n';
  assert.equal(parseFullReceipt(line).sha, sha);
  assert.throws(() => parseFullReceipt(line + line), /ambiguous/);
  assert.throws(() => parseFullReceipt('missing'), /missing/);
  console.log('Full selected-evidence reuse: exact-SHA run selection, per-ID coverage, ambiguous receipt negatives passed');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error('reuse-full-selected-evidence: ' +
      (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
