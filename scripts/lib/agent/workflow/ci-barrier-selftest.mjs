// Issue #4482 SC-02 CI barrier fixtures: freeze the applicable obligation for
// one exact HEAD, never treat missing/cancelled/unknown as success, and keep
// infrastructure-only failures distinct from actionable source failures.
import assert from 'node:assert/strict';
import {
  classifyCiResults, freezeCiObligation, sameEvidenceGeneration,
} from './ci-barrier.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const checks = [
  {
    name: 'quality', workflow: 'ci-quality', applicability: 'applicable',
    category: 'source', required: true,
  },
  {
    name: 'case-smoke', workflow: 'acceptance-case-smoke', applicability: 'applicable',
    category: 'source', required: true,
  },
  {
    name: 'web-tests', workflow: 'ci-quality', applicability: 'not_applicable',
    category: 'source', required: true,
  },
  {
    name: 'runner-network', workflow: 'ci-quality', applicability: 'unknown',
    category: 'infrastructure', required: true,
  },
  {
    name: 'optional-lint', workflow: 'ci-quality', applicability: 'applicable',
    category: 'source', required: false,
  },
];

const obligation = freezeCiObligation({ head_sha: HEAD, checks });
assert.equal(obligation.head_sha, HEAD);
assert.equal(obligation.checks.length, 3, 'not-applicable and non-required excluded');
assert.ok(!obligation.checks.some((check) => check.name === 'web-tests'));
assert.ok(!obligation.checks.some((check) => check.name === 'optional-lint'));
assert.deepEqual(
  obligation.checks.map((check) => check.name),
  [...obligation.checks.map((check) => check.name)]
    .sort((a, b) => a.localeCompare(b)),
  'obligation is deterministically sorted');
const again = freezeCiObligation({ head_sha: HEAD, checks });
assert.equal(again.obligation_sha256, obligation.obligation_sha256);

assert.throws(() => freezeCiObligation({ head_sha: 'main', checks }), /invalid obligation HEAD/);
assert.throws(() => freezeCiObligation({ head_sha: HEAD, checks: [] }), /invalid obligation checks/);
assert.throws(() => freezeCiObligation({
  head_sha: HEAD, checks: [checks[0], { ...checks[0] }],
}), /duplicate obligation check/);
assert.throws(() => freezeCiObligation({
  head_sha: HEAD,
  checks: [{ ...checks[0], category: 'model' }],
}), /invalid obligation check/);

function result(name, workflow, conclusion, ref = null) {
  return { name, workflow, conclusion, evidence_ref: ref };
}

const base = [
  result('quality', 'ci-quality', 'success'),
  result('case-smoke', 'acceptance-case-smoke', 'success'),
  result('runner-network', 'ci-quality', 'success'),
];

const pass = classifyCiResults({
  obligation, head_sha: HEAD, results: base, observed_at: 1,
});
assert.equal(pass.status, 'pass');
assert.equal(pass.obligation_sha256, obligation.obligation_sha256);
const passAgain = classifyCiResults({
  obligation, head_sha: HEAD, results: [...base].reverse(), observed_at: 2,
});
assert.equal(passAgain.digest, pass.digest, 'digest is order independent');

const pending = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [base[0], { ...base[1], conclusion: 'pending' }, base[2]],
});
assert.equal(pending.status, 'pending');

const missing = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1, results: [base[0], base[1]],
});
assert.equal(missing.status, 'missing', 'absent required check is not a pass');

const cancelled = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [base[0], { ...base[1], conclusion: 'cancelled' }, base[2]],
});
assert.equal(cancelled.status, 'missing');

const unknown = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [base[0], { ...base[1], conclusion: 'unknown' }, base[2]],
});
assert.equal(unknown.status, 'missing');

const skipped = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [base[0], { ...base[1], conclusion: 'skipped' }, base[2]],
});
assert.equal(skipped.status, 'missing', 'a required job that skipped proves nothing');

const actionable = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [{ ...base[0], conclusion: 'failure' }, base[1], base[2]],
});
assert.equal(actionable.status, 'actionable_fail');

const infrastructure = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [base[0], base[1], { ...base[2], conclusion: 'timed_out' }],
});
assert.equal(infrastructure.status, 'infrastructure');

const mixed = classifyCiResults({
  obligation, head_sha: HEAD, observed_at: 1,
  results: [{ ...base[0], conclusion: 'failure' }, base[1],
    { ...base[2], conclusion: 'timed_out' }],
});
assert.equal(mixed.status, 'actionable_fail',
  'a source failure outranks an infrastructure fault');

assert.equal(sameEvidenceGeneration(pass, passAgain), true);
assert.equal(sameEvidenceGeneration(pass, pending), false);

assert.throws(() => classifyCiResults({
  obligation, head_sha: OTHER, results: base, observed_at: 1,
}), /obligation HEAD/);
assert.throws(() => classifyCiResults({
  obligation, head_sha: HEAD, results: [base[0], base[0]], observed_at: 1,
}), /duplicate CI result/);
assert.throws(() => classifyCiResults({
  obligation, head_sha: HEAD, results: [{ ...base[0], conclusion: 'exploded' }],
  observed_at: 1,
}), /invalid CI result/);

console.log('agent workflow ci-barrier selftest: OK');
