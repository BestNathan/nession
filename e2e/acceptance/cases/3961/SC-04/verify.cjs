'use strict';
// #3961 SC-04: real protected Staging GHCR -> ACR source and BuildKit comparison.
// A Case never builds/publishes images or receives Registry/GitHub credentials.
// GitHub Actions' public run/Job/log readback is strictly read-only; only
// bounded numeric BuildKit progress counters leave the in-memory log parser.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const ROLES = ['server', 'agent', 'mcp', 'ui'];
const ARCHES = ['amd64', 'arm64'];
const BASELINE_RUN = 44445298335; // pre-hardening authenticated GHCR, eight builds
const BASELINE_SHA = '5a9fb12750b506fb7a97a93b518dac0c0767475e';
const REQUIRED_MAIN = 'ebc6fdc821a8be40d5c09686f4dd22b41f0ec88a'; // #3999 merge
const SHA = /^[0-9a-f]{40}$/;

class Unobservable extends Error {}
function safe(v) {
  return String(v ?? '').replace(/[^A-Za-z0-9 .,_:/()-]/g, ' ').slice(0, 180);
}
async function request(url, asText = false) {
  let response;
  try {
    response = await fetch(API + url, {
      headers: { Accept: 'application/vnd.github+json',
        'User-Agent': 'nession-3961-oci-source-case' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
  } catch {
    // Network/timeout/redirect errors cannot disprove an external release.
    throw new Unobservable('public GitHub source readback temporarily unreachable');
  }
  if (!response.ok) {
    if ([403, 404, 408, 429, 500, 502, 503, 504].includes(response.status))
      throw new Unobservable('public GitHub source readback not available');
    throw Error('unexpected GitHub response status ' + response.status);
  }
  if (asText) {
    const size = Number(response.headers.get('content-length') || 0);
    if (size > 8 * 1024 * 1024) throw new Unobservable('BuildKit log exceeds bounded limit');
    const body = await response.text();
    if (body.length > 8 * 1024 * 1024)
      throw new Unobservable('BuildKit log exceeds bounded limit');
    return body;
  }
  return response.json();
}
function authenticRun(run, name, workflow, sha) {
  return run && run.name === name &&
    run.path?.split('@')[0] === '.github/workflows/' + workflow &&
    run.event === 'push' && run.head_branch === 'staging' &&
    run.head_sha === sha && run.repository?.full_name === REPO &&
    run.head_repository?.full_name === REPO &&
    Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0;
}
function chooseRun(items, name, workflow, sha) {
  assert.match(sha, SHA);
  assert.ok(Array.isArray(items) && items.length <= 30, 'bounded workflow runs required');
  const matches = items.filter(r => authenticRun(r, name, workflow, sha))
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  if (!matches.length) throw new Unobservable('no authenticated exact-source ' + name + ' yet');
  const run = matches[0];
  if (run.status !== 'completed')
    throw new Unobservable('exact-source ' + name + ' remains in progress');
  assert.equal(run.conclusion, 'success', name + ' did not succeed');
  return run;
}
async function trustedRun(name, workflow, sha) {
  const list = await request('/actions/workflows/' + workflow +
    '/runs?head_sha=' + sha + '&per_page=30');
  return chooseRun(list.workflow_runs, name, workflow, sha);
}
async function jobsOf(run) {
  const data = await request('/actions/runs/' + run.id +
    '/attempts/' + run.run_attempt + '/jobs?per_page=100');
  assert.ok(Array.isArray(data.jobs) && data.jobs.length > 0 &&
    data.jobs.length <= 100, 'bounded exact-attempt Job receipt required');
  return data.jobs;
}
function passed(jobs, name, step) {
  const found = jobs.filter(j => j.name === name);
  assert.equal(found.length, 1, 'exactly one Job: ' + name);
  const job = found[0];
  assert.equal(job.status, 'completed', name + ' is incomplete');
  assert.equal(job.conclusion, 'success', name + ' failed');
  assert.ok(Number.isSafeInteger(job.id) && job.id > 0, 'job identity missing');
  if (step) {
    const matches = (job.steps || []).filter(s =>
      s.name === step && s.status === 'completed' && s.conclusion === 'success');
    assert.equal(matches.length, 1, name + ' must execute ' + step);
  }
  return job;
}
function checkReleaseJobs(jobs) {
  const result = [];
  for (const role of ROLES) for (const arch of ARCHES) {
    result.push(passed(jobs, 'docker-' + role + '-' + arch,
      'Run docker/build-push-action@v6'));
  }
  passed(jobs, 'merge');
  passed(jobs, 'provenance', 'Emit GHCR build provenance');
  return result;
}
function checkACRJobs(jobs) {
  passed(jobs, 'verify-source');
  passed(jobs, 'provenance');
  passed(jobs, 'deploy-staging-gitops');
  for (const role of ROLES) {
    passed(jobs, 'mirror-acr (' + role + ')',
      'Mirror and verify multi-arch ' + role + ' image');
  }
}
async function artifactsOf(run) {
  const result = await request('/actions/runs/' + run.id + '/artifacts?per_page=100');
  assert.ok(Array.isArray(result.artifacts) && result.artifacts.length <= 100,
    'bounded authenticated build artifacts required');
  const built = result.artifacts.filter(a => a.name?.endsWith('.dockerbuild'));
  assert.equal(built.length, 8, 'one BuildKit build record per role and architecture');
  for (const artifact of built) {
    assert.equal(artifact.expired, false, 'BuildKit record expired');
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 && artifact.size_in_bytes < 8 * 1024 * 1024,
    'invalid bounded BuildKit record size');
  }
  assert.equal(result.artifacts.filter(a =>
    a.name === 'nession-build-provenance' && !a.expired &&
    a.size_in_bytes > 0).length, 1, 'authenticated GHCR provenance artifact missing');
  return built.reduce((sum, a) => sum + a.size_in_bytes, 0);
}
// Parse ONLY anchored BuildKit progress markers. NEVER return raw logs,
// extracted URL, headers or arbitrary diagnostic bytes.
function safeBuildKitObservations(log) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024)
    throw new Unobservable('bounded BuildKit log unavailable');
  const cached = new Set(), done = new Set(), written = new Set();
  for (const line of log.split('\n')) {
    let m = /^\d{4}-\d\d-\d\dT[^\n]{1,26}Z #([0-9]{1,4}) CACHED(?:\s|$)/.exec(line);
    if (m) cached.add(m[1]);
    m = /^\d{4}-\d\d-\d\dT[^\n]{1,26}Z #([0-9]{1,4}) DONE(?:\s|$)/.exec(line);
    if (m) done.add(m[1]);
    m = /^\d{4}-\d\d-\d\dT[^\n]{1,26}Z #[0-9]{1,4} writing layer sha256:([0-9a-f]{64})(?:\s|$)/.exec(line);
    if (m) written.add(m[1]);
  }
  if (!cached.size && !done.size)
    throw new Unobservable('no observable BuildKit progress markers');
  return { cached_steps: cached.size, completed_steps: done.size,
    written_layer_digests: written.size };
}
async function observations(jobs) {
  const result = {};
  // Bounded: eight exact successful Job logs, no credentials and no log dump.
  for (const job of jobs) {
    result[job.name] = safeBuildKitObservations(
      await request('/actions/jobs/' + job.id + '/logs', true));
  }
  return result;
}
function durationSeconds(job) {
  const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  const seconds = (end - start) / 1000;
  assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds < 7200,
    'invalid bounded image Job elapsed time');
  return seconds;
}
function fixtureTests() {
  const sha = 'a'.repeat(40);
  const fake = (name, step) => ({name,id:56,status:'completed',conclusion:'success',
    steps:step?[{name:step,status:'completed',conclusion:'success'}]:[]});
  const build = ROLES.flatMap(role => ARCHES.map(arch =>
    fake('docker-' + role + '-' + arch,'Run docker/build-push-action@v6')));
  build.push(fake('merge'),fake('provenance','Emit GHCR build provenance'));
  assert.equal(checkReleaseJobs(build).length, 8);
  assert.throws(() => checkReleaseJobs(build.slice(1)), /exactly one Job/);
  assert.throws(() => checkReleaseJobs([...build,build[0]]), /exactly one Job/);
  assert.throws(() => checkReleaseJobs(build.map(x=>x===build[0]
    ?{...x,conclusion:'failure'}:x)), /failed/);
  assert.throws(() => checkReleaseJobs(build.map(x=>x===build[0]
    ?{...x,steps:[]}:x)), /must execute/);
  const fakeRun={name:'Release / Staging Artifacts',
    path:'.github/workflows/release-staging.yml@staging',event:'push',
    head_branch:'staging',head_sha:sha,repository:{full_name:REPO},
    head_repository:{full_name:REPO},status:'completed',conclusion:'success',
    id:57,run_number:9,run_attempt:1};
  assert.equal(chooseRun([fakeRun],fakeRun.name,'release-staging.yml',sha).id,57);
  assert.throws(()=>chooseRun([{...fakeRun,head_sha:'b'.repeat(40)}],
    fakeRun.name,'release-staging.yml',sha),Unobservable);
  assert.throws(()=>chooseRun([{...fakeRun,conclusion:'failure'}],
    fakeRun.name,'release-staging.yml',sha),/did not succeed/);
  assert.throws(()=>chooseRun([{...fakeRun,head_repository:{full_name:'wrong/repo'}}],
    fakeRun.name,'release-staging.yml',sha),Unobservable);
  const log='2026-11-19T04:05:01.0000000Z #17 CACHED\n' +
    '2026-11-19T04:05:02.0000000Z #18 DONE 0.3s\n' +
    '2026-11-19T04:05:03.0000000Z #18 writing layer sha256:'+'f'.repeat(64)+' 0.3s done\n';
  assert.deepEqual(safeBuildKitObservations(log),
    {cached_steps:1,completed_steps:1,written_layer_digests:1});
  assert.throws(()=>safeBuildKitObservations(
    'signed_url=https://token.invalid/?access_token=secret\n'),Unobservable);
  return 'exact-run/attempt, role matrix, failed/duplicate jobs, hostile-log and cache counters';
}
async function verify() {
  fixtureTests();
  const sha = targetSha();
  assert.match(sha, SHA);
  const ancestry = await request('/compare/' + REQUIRED_MAIN + '...' + sha);
  assert.equal(ancestry.merge_base_commit?.sha, REQUIRED_MAIN,
    'deployed Staging release must contain audited #3999 changes');
  assert.equal(ancestry.behind_by, 0);
  const release = await trustedRun('Release / Staging Artifacts',
    'release-staging.yml', sha);
  const acr = await trustedRun('Deploy / Staging ACR',
    'deploy-staging-acr.yml', sha);
  const releaseJobs = checkReleaseJobs(await jobsOf(release));
  checkACRJobs(await jobsOf(acr));
  const baseline = await request('/actions/runs/' + BASELINE_RUN);
  assert.ok(authenticRun(baseline, 'Release / Staging Artifacts',
    'release-staging.yml', BASELINE_SHA), 'baseline run must be authentic');
  assert.equal(baseline.status,'completed');
  assert.equal(baseline.conclusion,'success');
  const baselineJobs = checkReleaseJobs(await jobsOf(baseline));
  const [currentRecords, baselineRecords] = await Promise.all([
    artifactsOf(release), artifactsOf(baseline)]);
  const [currentObs, baselineObs] = await Promise.all([
    observations(releaseJobs), observations(baselineJobs)]);
  const baseIndex = new Map(baselineJobs.map(x=>[x.name,x]));
  const ev = [
    {type:'ci',value:'authenticated protected Staging '+sha+
      ' GHCR Run/Attempt '+release.id+'/'+release.run_attempt+
      ' eight role x architecture Buildx jobs, merge and immutable provenance succeeded'},
    {type:'ci',value:'exact-source four-role ACR Run/Attempt '+acr.id+'/'+acr.run_attempt+
      ' verify-source, role mirror readback, provenance and GitOps succeeded'},
    {type:'provenance',value:'eight unexpired BuildKit records: candidate_bytes='+
      currentRecords+' baseline_bytes='+baselineRecords+
      ' baselineRun='+BASELINE_RUN+' (record bytes are NOT image layer size)'},
  ];
  for(const job of releaseJobs) {
    const key=job.name, b=baselineObs[key], c=currentObs[key];
    assert.ok(b && c,'complete source-aligned BuildKit comparison required');
    ev.push({type:'ci',value:key+' baseline->candidate cached markers '+
      b.cached_steps+'->'+c.cached_steps+
      ', completed markers '+b.completed_steps+'->'+c.completed_steps+
      ', written layer digests '+b.written_layer_digests+'->'+c.written_layer_digests+
      ', elapsed seconds '+durationSeconds(baseIndex.get(key))+'->'+
      durationSeconds(job)});
  }
  return {status:'pass',
    summary:'New Staging GHCR eight-build/BuildKit cache-layer comparison and four-role ACR readback verified for '+sha,
    evidence:ev};
}
function run() {
  verify().then(result=>process.stdout.write(JSON.stringify(result)+'\n'))
    .catch(error=>{
      const pending=error instanceof Unobservable;
      process.stdout.write(JSON.stringify({status:pending?'pending':'fail',
        summary:pending?safe(error.message):'OCI source-aligned Case rejected: '+safe(error.message),
        evidence:[]})+'\n');
      if(!pending)process.exitCode=1;
    });
}
if (process.argv[2] === 'self-test') {
  fixtureTests();
  process.stdout.write('3961 OCI release Case self-test: positive and negative fixtures passed\n');
} else {
  run();
}
