#!/usr/bin/env node
// Owner: #2323 SC-01. One canonical Issue lifecycle vocabulary and a
// fail-closed state derivation. Evidence inputs must already be authenticated
// by their owners (Acceptance projection, Main promotion, Full Regression
// receipts, Release admission); this module only orders and names them.
import assert from 'node:assert/strict';

const SHA = /^[0-9a-f]{40}$/;
const LANE = /^[a-z][a-z0-9-]{0,62}$/;
const REGRESSION_RESULTS = new Set(['Pass', 'Fail', 'Pending', 'Error']);

export const STATES = Object.freeze([
  'in-development',
  'development-complete',
  'main-promoted',
  'regression-qualified',
  'released',
]);

function fail(message) {
  throw new Error(message);
}

function sha(value, label) {
  const text = String(value ?? '');
  if (!SHA.test(text)) fail(label + ' must be a 40-character hex SHA');
  return text;
}

function lane(value) {
  const text = String(value ?? '');
  if (!LANE.test(text)) fail('staging lane is invalid');
  return text;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' must be an object');
    }
  return value;
}

// `staging` is the Staging Development Complete proof for THIS Issue: every
// applicable SC passed in one eligible lane at the exact tested revision.
export function lifecycleState({ staging, promotion = null, regression = null, release = null }) {
  const staged = object(staging, 'staging evidence');
  const stageLane = lane(staged.environment_id ?? staged.lane);
  const stageSha = sha(staged.source_sha, 'staging source_sha');
  if (typeof staged.applicable_sc_passed !== 'boolean') {
    fail('staging applicable_sc_passed must be a boolean');
  }
  const developmentComplete = staged.applicable_sc_passed === true;

  let mainPromoted = false;
  let promotedSha = null;
  if (promotion != null) {
    const promoted = object(promotion, 'promotion evidence');
    promotedSha = sha(promoted.merge_sha, 'promotion merge_sha');
    if (promoted.includes_source_sha !== true) {
      fail('promotion must explicitly include the accepted source SHA');
    }
    mainPromoted = developmentComplete && promoted.source_sha === stageSha;
  }

  let regressionQualified = false;
  if (regression != null) {
    const run = object(regression, 'regression evidence');
    const regressionSha = sha(run.source_sha, 'regression source_sha');
    const result = String(run.result ?? '');
    if (!REGRESSION_RESULTS.has(result)) fail('unsupported regression result ' + result);
    // Only the exact promoted merge SHA qualifies. A green run against any
    // older or newer Main SHA can never be reused for this promotion.
    regressionQualified = mainPromoted && result === 'Pass' && regressionSha === promotedSha;
  }

  let released = false;
  if (release != null) {
    const admission = object(release, 'release evidence');
    const releaseSha = sha(admission.source_sha, 'release source_sha');
    if (typeof admission.admitted !== 'boolean' || typeof admission.approved !== 'boolean') {
      fail('release admitted/approved must be booleans');
    }
    released = regressionQualified && admission.admitted && admission.approved &&
      releaseSha === promotedSha;
  }

  const state = released ? 'released'
    : regressionQualified ? 'regression-qualified'
      : mainPromoted ? 'main-promoted'
        : developmentComplete ? 'development-complete'
          : 'in-development';
  const blockers = [];
  if (!developmentComplete) blockers.push('staging-acceptance-not-passing');
  else if (promotion == null) blockers.push('not-promoted-to-main');
  else if (!mainPromoted) blockers.push('promotion-does-not-include-accepted-source');
  if (mainPromoted && !regressionQualified) {
    if (regression == null) blockers.push('exact-main-regression-not-run');
    else if (String(regression.result) !== 'Pass') blockers.push('exact-main-regression-not-pass');
    else blockers.push('exact-main-regression-sha-mismatch');
  }
  if (regressionQualified && !released) {
    if (release == null) blockers.push('release-not-admitted');
    else if (!release.admitted) blockers.push('release-not-admitted');
    else if (!release.approved) blockers.push('release-approval-missing');
    else blockers.push('release-sha-mismatch');
  }
  return {
    state,
    environment_id: stageLane,
    source_sha: stageSha,
    development_complete: developmentComplete,
    main_promoted: mainPromoted,
    regression_qualified: regressionQualified,
    released,
    // The owner rule: an ordinary Issue is complete when its applicable SCs
    // pass in an eligible Staging lane. It does not wait for Main promotion or
    // for any Full Regression. Later failures open incidents, not fake Pending.
    issue_may_close: developmentComplete,
    blockers,
  };
}

function selfTest() {
  const stageSha = 'a'.repeat(40);
  const mergeSha = 'b'.repeat(40);
  const staging = { environment_id: 'staging-01', source_sha: stageSha, applicable_sc_passed: true };
  const promotion = { merge_sha: mergeSha, source_sha: stageSha, includes_source_sha: true };
  const regression = { source_sha: mergeSha, result: 'Pass' };
  const release = { source_sha: mergeSha, admitted: true, approved: true };

  assert.equal(lifecycleState({ staging: { ...staging, applicable_sc_passed: false } }).state,
    'in-development');
  assert.equal(lifecycleState({ staging: { ...staging, applicable_sc_passed: false } }).issue_may_close,
    false);

  const staged = lifecycleState({ staging });
  assert.equal(staged.state, 'development-complete');
  assert.equal(staged.issue_may_close, true);
  assert.equal(staged.main_promoted, false);
  assert.deepEqual(staged.blockers, ['not-promoted-to-main']);

  // A Main promotion without Staging proof is not Main Promoted.
  const promotedWithoutProof = lifecycleState({
    staging: { ...staging, applicable_sc_passed: false }, promotion,
  });
  assert.equal(promotedWithoutProof.state, 'in-development');
  assert.equal(promotedWithoutProof.main_promoted, false);
  assert.ok(promotedWithoutProof.blockers.includes('staging-acceptance-not-passing'));

  const promoted = lifecycleState({ staging, promotion });
  assert.equal(promoted.state, 'main-promoted');
  assert.equal(promoted.regression_qualified, false);
  assert.deepEqual(promoted.blockers, ['exact-main-regression-not-run']);

  const qualified = lifecycleState({ staging, promotion, regression });
  assert.equal(qualified.state, 'regression-qualified');
  assert.equal(qualified.released, false);
  assert.deepEqual(qualified.blockers, ['release-not-admitted']);

  // A green Full Regression against a different Main SHA never qualifies.
  const staleRegression = lifecycleState({
    staging, promotion, regression: { source_sha: 'c'.repeat(40), result: 'Pass' },
  });
  assert.equal(staleRegression.regression_qualified, false);
  assert.ok(staleRegression.blockers.includes('exact-main-regression-sha-mismatch'));

  const failingRegression = lifecycleState({
    staging, promotion, regression: { source_sha: mergeSha, result: 'Fail' },
  });
  assert.equal(failingRegression.regression_qualified, false);
  assert.ok(failingRegression.blockers.includes('exact-main-regression-not-pass'));

  const released = lifecycleState({ staging, promotion, regression, release });
  assert.equal(released.state, 'released');
  assert.deepEqual(released.blockers, []);

  const unapproved = lifecycleState({
    staging, promotion, regression, release: { ...release, approved: false },
  });
  assert.equal(unapproved.state, 'regression-qualified');
  assert.ok(unapproved.blockers.includes('release-approval-missing'));

  const wrongReleaseSha = lifecycleState({
    staging, promotion, regression, release: { ...release, source_sha: 'd'.repeat(40) },
  });
  assert.equal(wrongReleaseSha.released, false);
  assert.ok(wrongReleaseSha.blockers.includes('release-sha-mismatch'));

  assert.throws(() => lifecycleState({ staging: { ...staging, source_sha: 'short' } }),
    /40-character hex SHA/);
  assert.throws(() => lifecycleState({ staging: { ...staging, environment_id: 'Staging_01' } }),
    /staging lane is invalid/);
  assert.throws(() => lifecycleState({ staging: { ...staging, applicable_sc_passed: 'yes' } }),
    /must be a boolean/);
  assert.throws(() => lifecycleState({ staging, promotion: { merge_sha: mergeSha, source_sha: stageSha } }),
    /explicitly include/);
  assert.throws(() => lifecycleState({ staging, promotion, regression: { source_sha: mergeSha, result: 'Maybe' } }),
    /unsupported regression result/);
  assert.throws(() => lifecycleState({ staging, promotion, regression, release: { source_sha: mergeSha } }),
    /must be booleans/);

  console.log('acceptance-lifecycle: four-state derivation and fail-closed fixtures passed');
}

if (process.argv[1]?.endsWith('acceptance-lifecycle.mjs')) {
  if (process.argv[2] === 'self-test') selfTest();
  else {
    console.error('usage: acceptance-lifecycle.mjs self-test');
    process.exitCode = 2;
  }
}
