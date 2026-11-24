// Issue #4482 SC-02/SC-03 unified feedback fixtures: one immutable bundle,
// deduped blocking findings, prior-lineage linking and exactly one repair gate.
import assert from 'node:assert/strict';
import { assertSingleRepairIntent, buildFeedbackBundle } from './feedback.mjs';

const HEAD = 'a'.repeat(40);
const CI = { head_sha: HEAD, digest: 'b'.repeat(64), status: 'actionable_fail',
  checks: [{
    name: 'quality', workflow: 'ci-quality', conclusion: 'failure',
    applicability: 'applicable', evidence_ref: 'run/1#quality',
  }, {
    name: 'case-smoke', workflow: 'acceptance-case-smoke', conclusion: 'success',
    applicability: 'applicable', evidence_ref: null,
  }] };
const REVIEW = { head_sha: HEAD, digest: 'c'.repeat(64), outcome: 'changes_requested',
  findings: [{
    id: 'R-1', severity: 'blocking', category: 'correctness',
    message: 'two repairs', file: 'x.mjs', sc: 'SC-02',
  }, {
    id: 'R-1', severity: 'blocking', category: 'correctness',
    message: 'two repairs', file: 'x.mjs', sc: 'SC-02',
  }, {
    id: 'N-1', severity: 'nonblocking', category: 'style',
    message: 'naming', file: null, sc: null,
  }] };

const bundle = buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD, ci: CI, review: REVIEW, repair_round: 1,
});
assert.equal(bundle.sources.join(','), 'ci,review');
assert.equal(bundle.ci_digest, CI.digest);
assert.equal(bundle.review_digest, REVIEW.digest);
assert.equal(bundle.parent_sha256, null);
assert.deepEqual(bundle.finding_ids, [
  'ci:ci-quality:quality', 'review:R-1',
]);
assert.ok(!bundle.finding_ids.includes('review:N-1'), 'nonblocking is not a gate');
const same = buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD, ci: {
    ...CI, checks: [...CI.checks].reverse(),
  }, review: REVIEW, repair_round: 1,
});
assert.equal(same.bundle_sha256, bundle.bundle_sha256, 'bundle digest is deterministic');

const next = buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD, review: REVIEW,
  prior: bundle, repair_round: 2,
});
assert.equal(next.parent_sha256, bundle.bundle_sha256);
assert.ok(next.finding_ids.includes('ci:ci-quality:quality'),
  'unresolved prior findings stay visible');
assert.equal(next.sources.join(','), 'review');

const acceptance = buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD,
  acceptance: {
    head_sha: HEAD, digest: 'd'.repeat(64),
    failed_criteria: ['SC-01', 'SC-03'],
  },
  repair_round: 1,
});
assert.deepEqual(acceptance.sources, ['acceptance']);
assert.deepEqual(acceptance.finding_ids,
  ['acceptance:SC-01', 'acceptance:SC-03']);

const failingAcceptance = buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD,
  acceptance: { head_sha: HEAD, digest: 'd'.repeat(64), failed_criteria: [] },
  repair_round: 1,
});
assert.deepEqual(failingAcceptance.finding_ids, ['acceptance:pr']);

assert.throws(() => buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD, repair_round: 1,
}), /requires a result source/);
assert.throws(() => buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: 'e'.repeat(40), ci: CI, repair_round: 1,
}), /another HEAD/);
assert.throws(() => buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD,
  review: { ...REVIEW, findings: [
    { ...REVIEW.findings[0] },
    { ...REVIEW.findings[0], message: 'different claim' },
  ] },
  repair_round: 1,
}), /conflicting findings/);
assert.throws(() => buildFeedbackBundle({
  issue: 4482, pr: 4500, head_sha: HEAD, review: REVIEW, repair_round: 0,
}), /repair round/);

// Exactly one repair is allowed; two are rejected before any effect.
{
  const repair = { type: 'dispatch', role: 'developer', action: 'repair' };
  assert.equal(assertSingleRepairIntent([repair]).action, 'repair');
  assert.throws(() => assertSingleRepairIntent([repair, { ...repair }]), /two repair actions/);
}

console.log('agent workflow feedback selftest: OK');
