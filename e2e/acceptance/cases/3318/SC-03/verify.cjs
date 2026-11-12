'use strict';
// #3318 SC-03: verify a *real* trusted staging identity attempt against
// immutable GitHub Actions metadata and its actual Job log, not fixtures or
// self-reported Case output. The source Case has no GitHub token or cluster
// credentials and makes read-only requests for public repository records.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');

const REPO = 'BestNathan/nession';
const BASE = 'https://api.github.com/repos/' + REPO;
const IDENTITY_RUN = 43171332212;
const IDENTITY_JOB = 131025084704;
const RELEASE_RUN = 43169643789;
const SOURCE_SHA = '45f620373dff92ea296dfadebf5f2be83769f0f4';
const MAIN_SHA = 'dda91af646af2df99552e306171eaa5283fc9b15';
const REASON = 'observation environment does not match the trusted overlay';

function fetchPublic(path) {
  // Only fixed GitHub repository API endpoints; no request parameters from an
  // untrusted Issue or environment. Explicitly withhold CI and agent tokens.
  assert.ok(/^\/actions\/(runs\/\d+(\/jobs)?|jobs\/\d+\/logs)$/.test(path),
    'non-allowlisted public GitHub API path');
  const call = spawnSync('curl', [
    '--silent', '--show-error', '--fail', '--location', '--max-time', '25',
    '--header', 'Accept: application/vnd.github+json',
    '--header', 'User-Agent: nession-acceptance-case-3318',
    BASE + path,
  ], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GIT_ASKPASS: '/bin/false' },
  });
  if (call.error) throw call.error;
  assert.equal(call.status, 0, 'public read-only GitHub observation unavailable (no Pass inferred)');
  return String(call.stdout);
}

function json(path) {
  const value = JSON.parse(fetchPublic(path));
  assert.ok(value && typeof value === 'object', 'expected GitHub source record');
  return value;
}

run(({ evidence }) => {
  const caseSha = targetSha();
  const release = json('/actions/runs/' + RELEASE_RUN);
  assert.equal(release.id, RELEASE_RUN);
  assert.equal(release.repository?.full_name, REPO);
  assert.equal(release.head_repository?.full_name, REPO);
  assert.equal(release.run_attempt, 1);
  assert.equal(release.path, '.github/workflows/release-staging.yml');
  assert.equal(release.head_sha, SOURCE_SHA);
  assert.equal(release.head_branch, 'staging');
  assert.equal(release.event, 'push');
  assert.equal(release.status, 'completed');
  assert.equal(release.conclusion, 'success');

  const identity = json('/actions/runs/' + IDENTITY_RUN);
  assert.equal(identity.id, IDENTITY_RUN);
  assert.equal(identity.repository?.full_name, REPO);
  assert.equal(identity.head_repository?.full_name, REPO);
  assert.equal(identity.run_attempt, 1);
  assert.equal(identity.path, '.github/workflows/deploy-identity.yml');
  assert.equal(identity.head_branch, 'main');
  assert.equal(identity.head_sha, MAIN_SHA);
  assert.equal(identity.event, 'workflow_run');
  assert.equal(identity.status, 'completed');
  assert.equal(identity.conclusion, 'failure');

  const jobs = json('/actions/runs/' + IDENTITY_RUN + '/jobs');
  assert.ok(Array.isArray(jobs.jobs), 'missing native GitHub Job inventory');
  const job = jobs.jobs.find((x) => x.id === IDENTITY_JOB);
  assert.ok(job, 'selected identity attest Job is missing');
  assert.equal(job.run_attempt, 1);
  assert.equal(job.name, 'attest');
  assert.equal(job.conclusion, 'failure');
  const step = (job.steps || []).find((x) =>
    x.name === 'Wait boundedly for reconciled Staging workload identity');
  assert.ok(step && step.conclusion === 'failure',
    'real identity rejection step must fail closed');

  const logs = fetchPublic('/actions/jobs/' + IDENTITY_JOB + '/logs');
  const sourceLine = logs.split(/\r?\n/).find((s) => s.includes('TRUSTED_STAGING_RELEASE_V1 {'));
  assert.ok(sourceLine, 'missing authenticated release-source receipt');
  const source = JSON.parse(sourceLine.slice(sourceLine.indexOf('TRUSTED_STAGING_RELEASE_V1 ') +
    'TRUSTED_STAGING_RELEASE_V1 '.length));
  assert.deepEqual({
    id: source.source_run_id, attempt: source.source_run_attempt,
    sha: source.source_sha, environment: source.environment_id,
  }, { id: RELEASE_RUN, attempt: 1, sha: SOURCE_SHA, environment: 'staging' });

  const expected = 'Staging identity rejected (class=namespace, retryable=false, deployed=' +
    SOURCE_SHA + '): ' + REASON;
  assert.ok(logs.includes(expected),
    'missing source-bound sanitized rejection in the authentic failed Job log');
  assert.equal(logs.includes('DEPLOYMENT_ATTESTATION_V1 {'), false,
    'rejected identity must not emit an attestation receipt');

  evidence.push(
    { type: 'runtime', value: 'trusted Deploy / Identity run ' + IDENTITY_RUN +
      '/1 attest Job ' + IDENTITY_JOB + ' failed closed with class=namespace' },
    { type: 'runtime', value: 'trusted source Release / Staging Artifacts run ' +
      RELEASE_RUN + '/1 deployed SHA ' + SOURCE_SHA + ' event=push conclusion=success' },
    { type: 'runtime', value: 'signed source receipt binds exact release run/attempt and ' +
      'staging SHA; observed reason=' + REASON },
    { type: 'runtime', value: 'Case checkout SHA ' + caseSha +
      ' is separate from the independently observed deployed source SHA' },
  );
  return 'Authentic staging identity Job reports source-bound sanitized namespace rejection';
});
