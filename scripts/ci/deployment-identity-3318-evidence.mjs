#!/usr/bin/env node
// #3318 SC-03: trusted-main, token-isolated readback of one immutable real
// Staging release -> Deploy Identity Run/Job -> sanitized rejection.
// It is a source transport, not an Acceptance decision or token handoff.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'BestNathan/nession';
const RELEASE_RUN = 43169643789;
const IDENTITY_RUN = 43171332212;
const IDENTITY_JOB = 131025084704;
const RELEASE_SHA = '45f620373dff92ea296dfadebf5f2be83769f0f4';
const MAIN_SHA = 'dda91af646af2df99552e306171eaa5283fc9b15';
const REASON = 'observation environment does not match the trusted overlay';
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function checkSource(release, identity, jobs, rawLog) {
  assert.equal(release?.id, RELEASE_RUN);
  assert.equal(release?.repository?.full_name, REPO);
  assert.equal(release?.head_repository?.full_name, REPO);
  assert.equal(release?.run_attempt, 1);
  assert.equal(release?.path, '.github/workflows/release-staging.yml');
  assert.equal(release?.head_branch, 'staging');
  assert.equal(release?.head_sha, RELEASE_SHA);
  assert.equal(release?.event, 'push');
  assert.equal(release?.status, 'completed');
  assert.equal(release?.conclusion, 'success');

  assert.equal(identity?.id, IDENTITY_RUN);
  assert.equal(identity?.repository?.full_name, REPO);
  assert.equal(identity?.head_repository?.full_name, REPO);
  assert.equal(identity?.run_attempt, 1);
  assert.equal(identity?.path, '.github/workflows/deploy-identity.yml');
  assert.equal(identity?.head_branch, 'main');
  assert.equal(identity?.head_sha, MAIN_SHA);
  assert.equal(identity?.event, 'workflow_run');
  assert.equal(identity?.status, 'completed');
  assert.equal(identity?.conclusion, 'failure');

  assert.ok(Array.isArray(jobs?.jobs), 'GitHub Jobs response unavailable');
  const job = jobs.jobs.find(x => x.id === IDENTITY_JOB);
  assert.equal(job?.name, 'attest');
  assert.equal(job?.run_attempt, 1);
  assert.equal(job?.conclusion, 'failure');
  const step = job?.steps?.find(x => x.name ===
    'Wait boundedly for reconciled Staging workload identity');
  assert.equal(step?.conclusion, 'failure');

  assert.equal(typeof rawLog, 'string');
  assert.ok(rawLog.length > 0 && rawLog.length < 6 * 1024 * 1024,
    'bounded original GitHub Job log required');
  const lines = rawLog.split(/\r?\n/);
  const receipts = lines.flatMap(line => {
    const match = line.match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z TRUSTED_STAGING_RELEASE_V1 (\{.*\})$/);
    return match ? [JSON.parse(match[1])] : [];
  });
  assert.equal(receipts.length, 1, 'require exactly one actual source release receipt');
  const receipt = receipts[0];
  assert.deepEqual(receipt, {
    source_run_id: RELEASE_RUN,
    source_run_attempt: 1,
    source_sha: RELEASE_SHA,
    environment_id: 'staging',
  });
  const expectedRejection = 'Staging identity rejected (class=namespace, retryable=false, deployed=' +
    RELEASE_SHA + '): ' + REASON;
  const errors = lines.filter(line => line.includes('##[error]Staging identity rejected ('));
  assert.equal(errors.length, 1, 'require exactly one real sanitized rejection');
  assert.ok(errors[0].endsWith('##[error]' + expectedRejection),
    'unexpected non-allowlisted identity rejection');
  assert.equal(lines.some(line => /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z DEPLOYMENT_ATTESTATION_V1 /.test(line)),
    false, 'rejected job must not emit an attestation');

  return {
    schema_version: 1,
    kind: 'nession_3318_trusted_identity_source_v1',
    repository: REPO,
    release: {id: RELEASE_RUN, attempt: 1, sha: RELEASE_SHA,
      event: 'push', branch: 'staging', conclusion: 'success'},
    identity: {id: IDENTITY_RUN, attempt: 1, sha: MAIN_SHA,
      event: 'workflow_run', branch: 'main', conclusion: 'failure'},
    job: {id: IDENTITY_JOB, attempt: 1, name: 'attest', conclusion: 'failure',
      failing_step: step.name},
    source_receipt: receipt,
    rejection: {class: 'namespace', retryable: false, deployed_sha: RELEASE_SHA,
      message: REASON},
    job_log_sha256: 'sha256:' + crypto.createHash('sha256').update(rawLog).digest('hex'),
  };
}

function selfTest() {
  const run = (id, sha, branch, path, event, conclusion) => ({
    id, run_attempt: 1, head_sha: sha, head_branch: branch, path,
    event, status: 'completed', conclusion,
    repository: {full_name: REPO}, head_repository: {full_name: REPO},
  });
  const release = run(RELEASE_RUN, RELEASE_SHA, 'staging',
    '.github/workflows/release-staging.yml', 'push', 'success');
  const identity = run(IDENTITY_RUN, MAIN_SHA, 'main',
    '.github/workflows/deploy-identity.yml', 'workflow_run', 'failure');
  const jobs = {jobs: [{id: IDENTITY_JOB, run_attempt: 1, name: 'attest',
    conclusion: 'failure', steps: [{
      name: 'Wait boundedly for reconciled Staging workload identity',
      conclusion: 'failure',
    }]}]};
  const log = [
    '2026-11-12T06:54:01.0268403Z TRUSTED_STAGING_RELEASE_V1 ' +
      JSON.stringify({source_run_id: RELEASE_RUN, source_run_attempt: 1,
        source_sha: RELEASE_SHA, environment_id: 'staging'}),
    '2026-11-12T06:54:28.0698047Z ##[error]Staging identity rejected (class=namespace, retryable=false, deployed=' +
      RELEASE_SHA + '): ' + REASON,
  ].join('\n');
  const accepted = checkSource(release, identity, jobs, log);
  assert.equal(accepted.release.id, RELEASE_RUN);
  assert.equal(accepted.rejection.retryable, false);
  assert.match(accepted.job_log_sha256, SHA256);
  assert.throws(() => checkSource({...release, head_sha: MAIN_SHA}, identity, jobs, log));
  assert.throws(() => checkSource(release, {...identity, event:'workflow_dispatch'}, jobs, log));
  assert.throws(() => checkSource(release, identity, {...jobs, jobs:[]}, log));
  assert.throws(() => checkSource(release, identity, jobs, log.replace('class=namespace', 'class=digest')));
  assert.throws(() => checkSource(release, identity, jobs, log.replace('source_run_attempt":1', 'source_run_attempt":2')));
  assert.throws(() => checkSource(release, identity, jobs, log + '\n2026-11-12T06:55:00Z DEPLOYMENT_ATTESTATION_V1 {}'));
  assert.throws(() => checkSource(release, identity, jobs, ''));
  console.log('deployment-identity #3318 source self-test: exact Run/Job/Attempt/source, sanitized reason and adversarial negatives passed');
}

function readGhJson(endpoint) {
  return JSON.parse(readGh(endpoint));
}
function readGh(endpoint) {
  return execFileSync('gh', ['api', 'repos/' + REPO + endpoint], {
    encoding: 'utf8', maxBuffer: 6 * 1024 * 1024, timeout: 30000,
    env: process.env,
  });
}
function stage(file) {
  assert.ok(process.env.GH_TOKEN && process.env.GH_TOKEN.length > 8,
    'trusted GitHub token required exclusively in staging source-prestage step');
  const release = readGhJson('/actions/runs/' + RELEASE_RUN);
  const identity = readGhJson('/actions/runs/' + IDENTITY_RUN);
  const jobs = readGhJson('/actions/runs/' + IDENTITY_RUN + '/jobs?per_page=100');
  assert.ok(jobs.total_count === jobs.jobs.length,
    'original Jobs inventory must not be truncated');
  // Raw GitHub job log never reaches an uncredentialed Case or artifact.
  const log = readGh('/actions/jobs/' + IDENTITY_JOB + '/logs');
  const output = checkSource(release, identity, jobs, log);
  fs.writeFileSync(file, JSON.stringify(output) + '\n', {flag: 'wx', mode: 0o600});
  console.log('TRUSTED_3318_SOURCE_V1 run=' + IDENTITY_RUN + '/1 job=' + IDENTITY_JOB +
    ' release=' + RELEASE_RUN + '/1 deployed=' + RELEASE_SHA + ' class=namespace');
}
const command = process.argv[2];
if (command === 'self-test') selfTest();
else if (command === 'stage' && process.argv.length === 4) stage(process.argv[3]);
else throw new Error('usage: deployment-identity-3318-evidence.mjs <self-test|stage FILE>');
