'use strict';
// #3090 SC-01: the trusted Acceptance executor self-test must pass at the
// merged main SHA. The source-bound Staging PR verification fixture must carry
// the exact batch identity marker that the production path derives, and every
// existing negative fixture must still reject forged proof.
const fs = require('node:fs');
const path = require('node:path');
const {
  run, checked, targetSha,
} = require('../../../shared/control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../../../..');

run(({ evidence }) => {
  const sha = targetSha();
  const output = checked('node', ['scripts/acceptance-executor.mjs', 'self-test'], 120000);

  const fixture = fs.readFileSync(
    path.join(root, 'scripts/acceptance-staging-batch-pr-evidence.mjs'),
    'utf8',
  );
  if (!fixture.includes('batchIdentity') ||
      !fixture.includes('identity: batchIdentity({' )) {
    throw new Error(
      'the source-bound PR self-test fixture does not derive its batch identity marker',
    );
  }
  if (!output.includes('original staging integration PR source proof: complete original run cohort and negative fixtures passed')) {
    throw new Error('the source-bound PR self-test did not report a complete pass:\n' + output.slice(-3000));
  }
  if (!output.includes('acceptance-executor self-test: legacy, mixed-method and provenance cases passed')) {
    throw new Error('the executor self-test did not report its full case set:\n' + output.slice(-3000));
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': the Acceptance executor self-test passed, including the source-bound Staging PR proof and all negative fixtures',
  });
  evidence.push({
    type: 'runtime',
    value: 'the fixture builds its marker with batchIdentity, so the synthetic Issue carries the same source-bound identity the production plan derives',
  });
  return 'The trusted Acceptance executor self-test passes with the exact batch identity marker and unchanged negative fixtures';
});
