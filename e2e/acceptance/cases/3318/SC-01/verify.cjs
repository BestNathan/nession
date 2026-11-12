'use strict';
// #3318 SC-01: a deterministic identity mismatch produces an independently
// asserted, bounded sanitized rejection reason that the trusted workflow can
// surface; no secret or unrestricted raw metadata is disclosed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { root, runCollector } = require('../../../shared/deployment-identity-3318.cjs');

run(({ evidence }) => {
  targetSha();

  // A real digest mismatch: the running pod's immutable imageID differs from
  // the trusted provenance digest while both tags still match the overlay.
  const mismatch = runCollector({
    pods: (pods) => {
      pods.items[0].status.containerStatuses[0].imageID =
        'ghcr.io/bestnathan/nession@sha256:' + 'f'.repeat(64);
    },
  });
  assert.equal(mismatch.status, 2, 'non-retryable mismatch must fail closed (exit 2)');
  assert.equal(mismatch.outExists, false, 'a rejected attempt must not write an attestation');
  assert.equal(mismatch.stdout.includes('DEPLOYMENT_ATTESTATION_V1 '), false,
    'a rejected attempt must not print an attestation receipt');
  assert.ok(mismatch.rejection, 'the collector must emit exactly one rejection receipt');
  assert.equal(mismatch.rejection.kind, 'nession_deployment_identity_rejection');
  assert.equal(mismatch.rejection.class, 'digest');
  assert.equal(mismatch.rejection.retryable, false);
  assert.equal(mismatch.rejection.message,
    'agent workload imageID does not match the immutable provenance digest');
  const receipts = mismatch.stderr.split('\n')
    .filter((line) => line.startsWith('DEPLOYMENT_IDENTITY_REJECTION_V1 '));
  assert.equal(receipts.length, 1, 'exactly one bounded rejection line may be emitted');
  assert.equal(/nession-3318-|\/tmp\//.test(JSON.stringify(mismatch.rejection)), false,
    'the rejection receipt must not disclose runner paths');

  // Hostile or unexpected error text is withheld rather than echoed.
  const collectorUrl = pathToFileURL(
    path.join(root, 'scripts/deployment-identity-collect.mjs')).href;
  const hostile = spawnSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
const { deploymentIdentityRejection, formatDeploymentIdentityRejection } =
  await import(process.env.COLLECTOR_URL);
const withheld = deploymentIdentityRejection(Error('token=ghs_secretvalue\\nforged line'));
assert.equal(withheld.class, 'unknown');
assert.equal(withheld.message, 'unclassified deployment identity rejection');
assert.equal(JSON.stringify(withheld).includes('secretvalue'), false);
assert.equal(formatDeploymentIdentityRejection(Error('first\\nsecond')).split('\\n').length, 1);
`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, COLLECTOR_URL: collectorUrl, GH_TOKEN: '', GITHUB_TOKEN: '' },
  });
  assert.equal(hostile.status, 0, hostile.stderr || 'hostile-message withholding fixture failed');

  // The trusted workflow is the consumer: it prints only the allowlisted
  // receipt and never dumps arbitrary redirected stderr.
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-identity.yml'), 'utf8');
  assert.ok(workflow.includes("grep -m1 '^DEPLOYMENT_IDENTITY_REJECTION_V1 '"),
    'the workflow must read the bounded rejection receipt');
  assert.ok(/::error::Staging identity rejected \(class=/.test(workflow),
    'the workflow must surface the rejection class and message');
  assert.equal(/cat\s+"\$RUNNER_TEMP\/deployment-attempt\.stderr"/.test(workflow), false,
    'the workflow must not dump arbitrary collector stderr');

  evidence.push(
    { type: 'runtime', value: 'collector digest mismatch exit 2 with class=digest and no attestation receipt' },
    { type: 'runtime', value: 'hostile error text withheld as unclassified deployment identity rejection' },
    { type: 'runtime', value: 'workflow prints only the bounded DEPLOYMENT_IDENTITY_REJECTION_V1 receipt' },
  );
  return 'Deterministic identity mismatch yields a bounded sanitized rejection reason';
});
