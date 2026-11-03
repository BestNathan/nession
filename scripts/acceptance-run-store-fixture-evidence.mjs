// #1690 SC-10: read-only, exact-main fixture proof for canonical Acceptance.
// The disposable fixture is NOT evidence of production Rulesets, writer authorization,
// real agent-store checkpoint reads, or an external/WORM checkpoint.
import assert from 'node:assert/strict';

export const FIXTURE_WORKFLOW = '.github/workflows/ci-run-store-fixture-evidence.yml';
export const FIXTURE_NAME = 'CI / Run Store Fixture Evidence';
function isTrustedFixturePath(value) {
  return value === FIXTURE_WORKFLOW || value === FIXTURE_WORKFLOW + '@refs/heads/main';
}
const JOB_NAME = 'Immutable encrypted checkpoint and CAS fixture';
const REQUIRED_STEPS = [
  'Checkout exact trusted main SHA (no persisted credentials)',
  'Verify main-owned read-only fixture Workflow contract',
  'Run both canonical checkpoint and Run Store integrity Gates',
  'Preserve source-bound successful fixture evidence (not live Store proof)',
  'Upload finite-retention main SHA Gate evidence',
];
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function attestRunStoreFixture(run, jobs, artifacts, targetSha, repo) {
  if (repo !== 'BestNathan/nession' || !SHA.test(targetSha) ||
      !Number.isSafeInteger(run?.id) || run.id <= 0 ||
      !Number.isSafeInteger(run?.run_attempt) || run.run_attempt < 1 ||
      run.name !== FIXTURE_NAME || !isTrustedFixturePath(run.path) ||
      !['push', 'repository_dispatch'].includes(run.event) ||
      run.head_branch !== 'main' || run.head_sha !== targetSha ||
      run.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo)
    throw Error('unverified main-owned Run Store fixture workflow');
  if (!Array.isArray(jobs?.jobs) || jobs.jobs.length > 100)
    throw Error('invalid Run Store fixture jobs');
  const matched = jobs.jobs.filter(job => job?.name === JOB_NAME);
  if (matched.length !== 1) throw Error('missing or ambiguous Run Store fixture job');
  const job = matched[0];
  if (!Number.isSafeInteger(job.id) || job.id <= 0 ||
      job.run_id !== run.id || job.run_attempt !== run.run_attempt ||
      job.head_sha !== targetSha || job.status !== 'completed' ||
      job.conclusion !== 'success' || !Array.isArray(job.steps))
    throw Error('unverified exact-attempt Run Store fixture job');
  for (const name of REQUIRED_STEPS) {
    const matches = job.steps.filter(step => step?.name === name);
    if (matches.length !== 1 || matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success')
      throw Error('missing successful Run Store fixture step: ' + name);
  }
  if (!Array.isArray(artifacts?.artifacts) || artifacts.artifacts.length > 100)
    throw Error('invalid Run Store fixture artifacts');
  const artifactName = 'run-store-fixture-evidence-' + run.id + '-' + run.run_attempt;
  const matches = artifacts.artifacts.filter(item => item?.name === artifactName);
  if (matches.length !== 1) throw Error('missing or ambiguous Run Store fixture artifact');
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
      artifact.expired !== false || artifact.workflow_run?.id !== run.id ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes <= 0 || !DIGEST.test(artifact.digest) ||
      (artifact.workflow_run?.head_sha && artifact.workflow_run.head_sha !== targetSha))
    throw Error('unverified or expired Run Store fixture artifact');
  return {
    kind: 'verified_agent_store_disposable_fixture',
    schema_version: 1, repository: repo, target_sha: targetSha,
    workflow_run_id: run.id, run_attempt: run.run_attempt,
    workflow_path: run.path, workflow_event: run.event,
    job_id: job.id, artifact_id: artifact.id, artifact_name: artifactName,
    artifact_zip_digest: artifact.digest, artifact_retention: 'finite',
    gate_ids: ['agent-checkpoint-store', 'run-store-integrity'],
    verdict: 'fixture_pass',
    live_branch_enforcement: 'not_tested',
    external_anchor: 'not_provisioned',
    real_agent_store: 'not_tested',
    provenance: 'GitHub authenticated exact-main Run, exact-attempt Job/Gate steps, and retained artifact metadata',
  };
}

export async function collectRunStoreFixtureEvidence(repo, sha, directRuns, get) {
  if (repo !== 'BestNathan/nession' || !SHA.test(sha) ||
      !Array.isArray(directRuns) || typeof get !== 'function')
    throw Error('invalid Run Store fixture evidence discovery');
  const candidates = directRuns.filter(run =>
    run?.name === FIXTURE_NAME && isTrustedFixturePath(run.path) &&
    run.head_sha === sha && run.head_branch === 'main' &&
    ['push', 'repository_dispatch'].includes(run.event) &&
    run.status === 'completed' && run.conclusion === 'success')
    .sort((a, b) => b.id - a.id).slice(0, 3);
  for (const candidate of candidates) {
    const base = '/repos/' + repo + '/actions/runs/' + candidate.id;
    const run = await get(base);
    if (run?.id !== candidate.id) throw Error('Run Store fixture candidate identity drift');
    const [jobs, artifacts] = await Promise.all([
      get(base + '/attempts/' + run.run_attempt + '/jobs?per_page=100'),
      get(base + '/artifacts?per_page=100'),
    ]);
    try { return [attestRunStoreFixture(run, jobs, artifacts, sha, repo)]; }
    catch { /* A failed/expired candidate cannot authorize a Pass; try an earlier valid run. */ }
  }
  return [];
}

export function selfTestRunStoreFixtureEvidence() {
  const sha = 'a'.repeat(40), repo = 'BestNathan/nession';
  const identity = {full_name: repo};
  const run = {id: 42, run_attempt: 2, name: FIXTURE_NAME,
    path: FIXTURE_WORKFLOW, event: 'push', head_branch: 'main', head_sha: sha,
    repository: identity, head_repository: identity,
    status: 'completed', conclusion: 'success'};
  const job = {id: 88, run_id: 42, run_attempt: 2, head_sha: sha,
    name: JOB_NAME, status: 'completed', conclusion: 'success',
    steps: REQUIRED_STEPS.map(name => ({name, status: 'completed', conclusion: 'success'}))};
  const artifact = {id: 91, name: 'run-store-fixture-evidence-42-2',
    expired: false, size_in_bytes: 510, digest: 'sha256:' + 'b'.repeat(64),
    workflow_run: {id:42,head_sha: sha}};
  const verify = (r=run, j=job, a=artifact) =>
    attestRunStoreFixture(r, {jobs:[j]}, {artifacts:[a]}, sha, repo);
  assert.equal(verify().verdict, 'fixture_pass');
  assert.equal(verify({...run,path:FIXTURE_WORKFLOW+'@refs/heads/main'}).verdict, 'fixture_pass');
  assert.throws(() => verify({...run,path:FIXTURE_WORKFLOW+'@refs/heads/untrusted'}));
  assert.equal(verify().live_branch_enforcement, 'not_tested');
  assert.throws(() => verify({...run,head_sha:'c'.repeat(40)}));
  assert.throws(() => verify({...run,event:'pull_request'}));
  assert.throws(() => verify({...run,repository:{full_name:'attacker/repo'}}));
  assert.throws(() => verify({...run,run_attempt:3}));
  assert.throws(() => verify(run,{...job,run_attempt:1}));
  assert.throws(() => verify(run,{...job,steps:job.steps.map(step =>
    step.name === REQUIRED_STEPS[2] ? {...step, conclusion:'skipped'} : step)}));
  assert.throws(() => verify(run,job,{...artifact,expired:true}));
  assert.throws(() => verify(run,job,{...artifact,workflow_run:{id:99,head_sha:sha}}));
  assert.throws(() => verify(run,job,{...artifact,digest:'bad'}));
  assert.throws(() => verify(run,job,{...artifact,workflow_run:{head_sha:'c'.repeat(40)}}));
  return true;
}
