'use strict';
// #3318 SC-02: retryable readiness remains bounded exit 75; non-retryable
// identity failures remain nonzero and fail closed with no attestation or
// rejection-to-Pass conversion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { runCollector } = require('../../../shared/deployment-identity-3318.cjs');

run(({ evidence }) => {
  targetSha();

  // A rolling/mid-rollout pod state is the only retryable class.
  const readiness = runCollector({
    pods: (pods) => { pods.items[1].status.phase = 'Pending'; },
  });
  assert.equal(readiness.status, 75, 'retryable readiness must use EX_TEMPFAIL (75)');
  assert.ok(readiness.rejection, 'the retryable attempt must still emit its bounded reason');
  assert.equal(readiness.rejection.class, 'readiness');
  assert.equal(readiness.rejection.retryable, true);
  assert.equal(readiness.outExists, false, 'a retryable attempt must not write an attestation');
  assert.equal(readiness.stdout.includes('DEPLOYMENT_ATTESTATION_V1 '), false,
    'a retryable attempt must not print an attestation receipt');

  // A namespace mismatch is a trust violation, never retried.
  const nonRetryable = runCollector({
    deployments: (deployments) => {
      deployments.items[2].metadata.namespace = 'nession-staging-01';
    },
  });
  assert.equal(nonRetryable.status, 2, 'non-retryable identity mismatch must fail closed');
  assert.ok(nonRetryable.rejection);
  assert.equal(nonRetryable.rejection.class, 'namespace');
  assert.equal(nonRetryable.rejection.retryable, false);
  assert.equal(nonRetryable.outExists, false);
  assert.equal(nonRetryable.stdout.includes('DEPLOYMENT_ATTESTATION_V1 '), false);

  // Valid counterexample: a reconciled identity still attests normally.
  const valid = runCollector();
  assert.equal(valid.status, 0, valid.stderr || 'valid fixture must attest');
  assert.equal(valid.outExists, true, 'a successful attestation writes the canonical receipt');
  assert.ok(valid.stdout.includes('DEPLOYMENT_ATTESTATION_V1 '));
  assert.equal(valid.rejection, null, 'success must not emit a rejection receipt');

  // A workflow_run trigger has no manual event.inputs.environment. The
  // collector must consume the already validated trusted lane identity, not
  // an empty dispatch-only expression (real #3318 namespace failure).
  const workflow = fs.readFileSync(
    path.join(require('../../../shared/deployment-identity-3318.cjs').root,
      '.github/workflows/deploy-identity.yml'), 'utf8');
  assert.ok(workflow.includes('echo "ENVIRONMENT=$ENVIRONMENT"'),
    'validated environment must be exported to subsequent steps');
  assert.ok(workflow.includes('--environment "$ENVIRONMENT"'),
    'collector must consume the validated environment for all event types');
  assert.equal(workflow.includes('--environment "${{ github.event.inputs.environment }}"'),
    false, 'workflow_run must not pass an empty manual-dispatch input');

  evidence.push(
    { type: 'runtime', value: 'rolling readiness exits 75 with retryable=true and no attestation' },
    { type: 'runtime', value: 'namespace mismatch exits 2 with retryable=false and no attestation' },
    { type: 'runtime', value: 'reconciled fixture exits 0 and writes the canonical attestation' },
    { type: 'runtime', value: 'workflow_run collector consumes validated environment instead of missing dispatch input' },
  );
  return 'Retryable readiness stays 75; trust violations stay fail-closed at 2';
});
