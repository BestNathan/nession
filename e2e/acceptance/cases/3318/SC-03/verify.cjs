'use strict';
// #3318 SC-03: executable, source-bound staging proof from the protected
// original GitHub Run/Job/Attempt. Trusted Main first authenticates and
// sanitizes the readback; this uncredentialed target Case checks exact fields.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const IDENTITY_RUN = 43171332212;
const IDENTITY_JOB = 131025084704;
const RELEASE_RUN = 43169643789;
const SOURCE_SHA = '45f620373dff92ea296dfadebf5f2be83769f0f4';
const MAIN_SHA = 'dda91af646af2df99552e306171eaa5283fc9b15';
const REASON = 'observation environment does not match the trusted overlay';

run(({ evidence }) => {
  const caseSha = targetSha();
  const file = process.env.NSESSION_3318_IDENTITY_SOURCE_FILE;
  assert.ok(file && file.startsWith('/'), 'missing trusted-main source staging path');
  // Target Case never receives GH_TOKEN, Kubeconfig or unfiltered Job logs.
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(source.schema_version, 1);
  assert.equal(source.kind, 'nession_3318_trusted_identity_source_v1');
  assert.equal(source.repository, REPO);
  assert.deepEqual(source.release, {
    id: RELEASE_RUN, attempt: 1, sha: SOURCE_SHA, event: 'push',
    branch: 'staging', conclusion: 'success',
  });
  assert.deepEqual(source.identity, {
    id: IDENTITY_RUN, attempt: 1, sha: MAIN_SHA,
    event: 'workflow_run', branch: 'main', conclusion: 'failure',
  });
  assert.deepEqual(source.job, {
    id: IDENTITY_JOB, attempt: 1, name: 'attest', conclusion: 'failure',
    failing_step: 'Wait boundedly for reconciled Staging workload identity',
  });
  assert.deepEqual(source.source_receipt, {
    source_run_id: RELEASE_RUN, source_run_attempt: 1, source_sha: SOURCE_SHA,
    environment_id: 'staging',
  });
  assert.deepEqual(source.rejection, {
    class: 'namespace', retryable: false,
    deployed_sha: SOURCE_SHA, message: REASON,
  });
  assert.match(source.job_log_sha256,
    /^sha256:[a-f0-9]{64}$/, 'missing original GitHub Job log checksum');

  evidence.push(
    {type: 'runtime', value: 'trusted original Deploy / Identity Run ' +
      IDENTITY_RUN + '/1, Job ' + IDENTITY_JOB + ' attest failure classified namespace, retryable=false'},
    {type: 'runtime', value: 'original Release / Staging Artifacts Run ' +
      RELEASE_RUN + '/1 successful at exact deployed SHA ' + SOURCE_SHA},
    {type: 'runtime', value: 'source receipt binds release Run/Attempt and staging environment; sanitized reason=' + REASON},
    {type: 'runtime', value: 'trusted Main pre-staged original Job log hash ' + source.job_log_sha256 +
      '; Case checkout=' + caseSha},
  );
  return 'Original authenticated staging identity Run/Job produced a bounded, source-bound rejection';
});
