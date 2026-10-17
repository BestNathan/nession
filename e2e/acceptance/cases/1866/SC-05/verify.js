'use strict';
// #1866 SC-05: the job-scoped Acceptance batch must fall back to a fresh
// runtime for a Case that does not opt into sharing, must never mix runtime
// profiles, and a failed shared runtime must not suppress later evidence.
//
// This executes the REAL planner and executor with an injected runtime
// factory, so the criterion is proven by behavior rather than by prose.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  executeAcceptanceBatches,
  planAcceptanceBatches,
} = require(path.resolve(__dirname, '../../../../runner/acceptance-batch.mjs'));

const TARGET = 'a'.repeat(40);

function plan(manifests, cases) {
  const resolveManifest = (_root, entry) => {
    const manifest = manifests.get(entry.issue + ':' + entry.criterion);
    if (!manifest) throw new Error('unknown Case');
    return manifest;
  };
  return planAcceptanceBatches({ repoRoot: '.', cases, resolveManifest });
}

function shape(batches) {
  return batches.map((batch) => ({
    shared: batch.shared,
    profile: batch.profile,
    cases: batch.cases.map((entry) => entry.issue + '/' + entry.criterion),
  }));
}

async function main() {
  const manifests = new Map([
    ['1:SC-01', { runtime: 'full-stack-local', isolation: 'shared' }],
    ['2:SC-01', { runtime: 'full-stack-local', isolation: 'shared' }],
    ['3:SC-01', { runtime: 'full-stack-local' }], // never opted in
    ['4:SC-01', { runtime: 'other-profile', isolation: 'shared' }],
  ]);

  // A Case that does not opt into sharing never joins the shared batch.
  assert.deepEqual(shape(plan(manifests, [
    { issue: 1, criterion: 'SC-01' },
    { issue: 2, criterion: 'SC-01' },
    { issue: 3, criterion: 'SC-01' },
  ])), [
    { shared: true, profile: 'full-stack-local', cases: ['1/SC-01', '2/SC-01'] },
    { shared: false, profile: 'full-stack-local', cases: ['3/SC-01'] },
  ]);

  // An incompatible profile never shares, even when both opted in.
  assert.deepEqual(shape(plan(manifests, [
    { issue: 1, criterion: 'SC-01' },
    { issue: 4, criterion: 'SC-01' },
  ])), [
    { shared: false, profile: 'full-stack-local', cases: ['1/SC-01'] },
    { shared: false, profile: 'other-profile', cases: ['4/SC-01'] },
  ]);

  const contractsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc05-contracts-'));
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc05-results-'));
  try {
    for (const issue of [1, 2, 3, 4]) {
      fs.writeFileSync(path.join(contractsDir, issue + '.json'),
        JSON.stringify({ number: issue, body: '' }));
    }
    const record = (options) => ({
      issue: options.issueNumber,
      criterion: options.criterion,
      result: 'Pass',
    });
    const run = (batches, options = {}) => executeAcceptanceBatches({
      repoRoot: '.',
      batches,
      stage: 'post-merge',
      targetSha: TARGET,
      runId: 1,
      runAttempt: 1,
      resultsDir,
      contractsDir,
      log: () => {},
      ...options,
    });

    // The opted-in pair reuses ONE resolved runtime; the non-opted Case runs on
    // its own fresh runtime (the explicit fallback), and the shared one is
    // stopped exactly once.
    const seen = [];
    let stops = 0;
    const runtime = { stop: async () => { stops += 1; } };
    const sharedPlan = plan(manifests, [
      { issue: 1, criterion: 'SC-01' },
      { issue: 2, criterion: 'SC-01' },
      { issue: 3, criterion: 'SC-01' },
    ]);
    const ok = await run(sharedPlan, {
      runtimeFactory: async () => runtime,
      runCaseImpl: async (options) => { seen.push(options.runtime); return record(options); },
    });
    assert.equal(ok.records.length, 3);
    assert.equal(ok.errors.length, 0);
    assert.equal(seen[0], runtime);
    assert.equal(seen[1], runtime);
    assert.equal(seen[2], null, 'non-opted Case must own a fresh runtime');
    assert.equal(stops, 1);

    // A shared runtime that cannot become ready is an error for that batch
    // only; the later non-opted Case still produces its own evidence.
    const failPlan = plan(manifests, [
      { issue: 1, criterion: 'SC-01' },
      { issue: 2, criterion: 'SC-01' },
      { issue: 3, criterion: 'SC-01' },
    ]);
    const survived = await run(failPlan, {
      runtimeFactory: async () => { throw new Error('stack unavailable'); },
      runCaseImpl: async (options) => record(options),
    });
    assert.deepEqual(survived.records.map((item) => item.issue), [3]);
    assert.deepEqual(survived.errors.map((item) => item.issue), [1, 2]);
    assert.match(survived.errors[0].message, /batch runtime: stack unavailable/);
  } finally {
    fs.rmSync(contractsDir, { recursive: true, force: true });
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'The batch planner isolates a non-opted Case on its own fresh runtime, splits ' +
      'incompatible profiles, and a failed shared runtime never suppresses later evidence.',
    evidence: [
      { type: 'runtime', value: 'non-opted Case executed on a freshly-started runtime while the opted-in pair shared one' },
      { type: 'runtime', value: 'profile mismatch produced separate batches rather than cross-Case contamination' },
      { type: 'runtime', value: 'failed shared runtime recorded per-Case errors and preserved the later Case record' },
    ],
  }) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'runtime', value: 'SC-05 batch isolation contract failed' }],
  }) + '\n');
  process.exitCode = 1;
});
