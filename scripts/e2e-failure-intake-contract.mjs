#!/usr/bin/env node
// Trusted-source contract for #2345. Pure validator only: callers MUST obtain
// run and artifact metadata from GitHub's API, and target_sha from the trusted
// Main-owned pin step/receipt. This module performs no network or Store writes.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;

function reject(reason) {
  return { status: 'INELIGIBLE', dispatch_allowed: false, reason };
}

export function verifyFullRegressionFailure({ repository, run, artifact, candidate, trustedTargetSha }) {
  if (!repository || repository.full_name !== 'BestNathan/nession') return reject('wrong repository');
  if (!run || typeof run !== 'object') return reject('missing authenticated run metadata');
  if (run.path !== '.github/workflows/e2e-full-regression.yml' ||
      run.name !== 'E2E / Full Regression') return reject('workflow is not allowlisted');
  if (!['schedule', 'workflow_dispatch'].includes(run.event)) return reject('event is not allowlisted');
  if (run.status !== 'completed' || run.conclusion !== 'failure') return reject('run is not a completed failure');
  if (!positive(run.id) || !positive(run.run_attempt)) return reject('exact run and attempt required');
  if (!SHA.test(String(trustedTargetSha ?? ''))) return reject('trusted target SHA missing');
  if (!artifact || artifact.expired === true || artifact.workflow_run?.id !== run.id ||
      artifact.name !== `full-regression-${run.id}-${run.run_attempt}` ||
      !positive(artifact.id) || typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
    return reject('artifact identity does not match exact run/attempt');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return reject('candidate missing or malformed');
  }
  if (candidate.schema_version !== 1 || candidate.kind !== 'e2e_full_failure_candidate' ||
      candidate.provenance !== 'UNATTESTED_ARTIFACT_ONLY') {
    return reject('candidate contract/provenance invalid');
  }
  if (candidate.run_id !== run.id || candidate.run_attempt !== run.run_attempt ||
      candidate.target_sha !== trustedTargetSha) {
    return reject('candidate run/attempt/target SHA mismatch');
  }
  if (!['FAILED_TESTS_OBSERVED', 'UNCLASSIFIED_FAILURE', 'NON_PASS_OR_UNKNOWN_OBSERVED',
        'NO_FAILED_TESTS_OBSERVED_NOT_PASS', 'REPORT_UNAVAILABLE'].includes(candidate.status) ||
      !Array.isArray(candidate.results) || candidate.results.length > 64) {
    return reject('candidate status/results invalid');
  }
  const ids = new Set();
  for (const item of candidate.results) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) ||
        ids.has(item.id) || !['total', 'failed', 'skipped', 'flaky', 'expected', 'other'].every(
          key => Number.isSafeInteger(item[key]) && item[key] >= 0) ||
        item.failed + item.skipped + item.flaky + item.expected + item.other !== item.total) {
      return reject('candidate per-ID result is malformed');
    }
    ids.add(item.id);
  }
  // A trusted source identity permits recording this candidate, not automatically
  // declaring a product regression. A separate classifier must inspect receipts.
  return {
    status: 'AUTHENTICATED_CANDIDATE',
    dispatch_allowed: false,
    repository: repository.full_name,
    workflow_path: run.path,
    run_id: run.id,
    run_attempt: run.run_attempt,
    target_sha: trustedTargetSha,
    artifact_id: artifact.id,
    artifact_digest: artifact.digest,
    observed_failed_ids: candidate.results.filter(item => item.failed > 0).map(item => item.id),
    classification_required: true,
  };
}

function selfTest() {
  const run = { id: 501, run_attempt: 2, path: '.github/workflows/e2e-full-regression.yml',
    name: 'E2E / Full Regression', event: 'schedule', status: 'completed', conclusion: 'failure' };
  const target = 'a'.repeat(40);
  const artifact = { id: 700, name: 'full-regression-501-2', expired: false,
    digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: 501 } };
  const candidate = { schema_version: 1, kind: 'e2e_full_failure_candidate',
    provenance: 'UNATTESTED_ARTIFACT_ONLY', target_sha: target, run_id: 501, run_attempt: 2,
    status: 'FAILED_TESTS_OBSERVED', results: [{ id: 'terminal-attach', total: 2,
      failed: 1, skipped: 0, flaky: 0, expected: 1, other: 0 }] };
  const input = { repository: { full_name: 'BestNathan/nession' }, run, artifact, candidate,
    trustedTargetSha: target };
  const accepted = verifyFullRegressionFailure(input);
  assert.equal(accepted.status, 'AUTHENTICATED_CANDIDATE');
  assert.equal(accepted.dispatch_allowed, false, 'authentication alone must never dispatch');
  assert.deepEqual(accepted.observed_failed_ids, ['terminal-attach']);
  const negatives = [
    { ...input, repository: { full_name: 'attacker/fork' } },
    { ...input, run: { ...run, path: '.github/workflows/attacker.yml' } },
    { ...input, run: { ...run, event: 'pull_request' } },
    { ...input, run: { ...run, conclusion: 'success' } },
    { ...input, run: { ...run, run_attempt: 3 } },
    { ...input, artifact: { ...artifact, workflow_run: { id: 999 } } },
    { ...input, artifact: { ...artifact, name: 'full-regression-501-1' } },
    { ...input, artifact: { ...artifact, digest: 'sha256:bad' } },
    { ...input, candidate: { ...candidate, target_sha: 'c'.repeat(40) } },
    { ...input, trustedTargetSha: 'main' },
    { ...input, candidate: { ...candidate, results: [{ ...candidate.results[0], failed: -1 }] } },
    { ...input, candidate: { ...candidate, results: [candidate.results[0], candidate.results[0]] } },
  ];
  for (const bad of negatives) assert.equal(verifyFullRegressionFailure(bad).status, 'INELIGIBLE');
  console.log('e2e-failure-intake-contract self-test: PASS');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'self-test') throw new Error('usage: self-test');
    selfTest();
  } catch (error) {
    console.error('e2e-failure-intake-contract: ' + error.message);
    process.exitCode = 2;
  }
}
