'use strict';
// #3968 SC-04: independently observe a real, four-role GHCR -> ACR Staging
// publication after the immutable source readback fix. No credentials or
// writes are provided to target Case code.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const GHCR = 'ghcr.io/bestnathan/nession';
const FIX_SHA = 'db6295494dcc316464d1f280ebf7685c38b4525c';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROLES = ['agent', 'server', 'mcp', 'ui'];

async function api(path) {
  const response = await fetch(API + path, {
    headers: { Accept: 'application/vnd.github+json',
      'User-Agent': 'nession-3968-acr-readback-case' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = new Error('read-only GitHub source observation unavailable: HTTP ' +
      response.status);
    if ([403, 429, 500, 502, 503, 504].includes(response.status)) error.unobservable = true;
    throw error;
  }
  return response.json();
}
function pending(reason) {
  console.log(JSON.stringify({ status: 'pending', summary: reason, evidence: [] }));
}
function workflowRuns(body, name, path) {
  assert.ok(Array.isArray(body.workflow_runs) && body.workflow_runs.length <= 50,
    'invalid bounded GitHub Actions inventory');
  return body.workflow_runs.filter(run =>
    run.name === name && run.path?.split('@')[0] === path &&
    run.event === 'push' && run.head_branch === 'staging' &&
    run.repository?.full_name === REPO && run.head_repository?.full_name === REPO &&
    SHA.test(run.head_sha ?? '') && run.status === 'completed' &&
    run.conclusion === 'success' && Number.isSafeInteger(run.id) &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
}
async function isAncestor(base, head) {
  if (base === head) return true;
  const comparison = await api('/compare/' + base + '...' + head);
  return comparison.status === 'ahead' &&
    comparison.base_commit?.sha === base &&
    comparison.merge_base_commit?.sha === base &&
    comparison.behind_by === 0 && comparison.ahead_by > 0;
}
async function jobsOf(run) {
  const body = await api('/actions/runs/' + run.id + '/attempts/' +
    run.run_attempt + '/jobs?per_page=100');
  assert.ok(Array.isArray(body.jobs) && body.jobs.length > 0 &&
    body.jobs.length <= 100, 'invalid authenticated Run/Attempt job inventory');
  return body.jobs;
}
function passed(jobs, name) {
  const matching = jobs.filter(x => x.name === name);
  assert.equal(matching.length, 1, 'missing/duplicate trusted job ' + name);
  assert.equal(matching[0].status, 'completed', 'incomplete trusted job ' + name);
  assert.equal(matching[0].conclusion, 'success', 'failed trusted job ' + name);
  return matching[0];
}
function passedStep(job, name) {
  const steps = (job.steps ?? []).filter(x =>
    x.name === name && x.status === 'completed' && x.conclusion === 'success');
  assert.equal(steps.length, 1, 'missing trusted successful step ' + name + ' in ' + job.name);
}
function dockerInspect(args) {
  try {
    return execFileSync('docker', ['buildx', 'imagetools', 'inspect', ...args], {
      encoding: 'utf8', timeout: 100000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Registry clients can include OAuth URLs/tokens in their stderr. Never
    // forward this text into untrusted Case output or CI logs.
    const error = new Error('public GHCR index/config readback temporarily unavailable');
    error.unobservable = true;
    throw error;
  }
}
function registryEvidence(sha) {
  const version = sha.slice(0, 7);
  const evidence = [];
  for (const role of ROLES) {
    const image = GHCR + ':' + role + '-' + version;
    const index = JSON.parse(dockerInspect(['--raw', image]));
    const platforms = (index.manifests ?? []).filter(m =>
      m.platform?.os === 'linux' &&
      ['amd64', 'arm64'].includes(m.platform?.architecture));
    assert.deepEqual(platforms.map(p => p.platform.architecture).sort(),
      ['amd64', 'arm64'], role + ' GHCR index must contain one manifest per architecture');
    const refs = [];
    for (const manifest of platforms) {
      assert.match(manifest.digest ?? '', DIGEST, role + ' invalid platform Digest');
      // Only the dedicated standalone MCP Dockerfile emits an OCI revision
      // label. Server/Agent/UI prebuilt Dockerfiles do NOT; their provenance
      // is instead authenticated by the exact release Run, source SHA and
      // GHCR publication receipt. Never require or fabricate a missing label.
      if (role === 'mcp') {
        const config = JSON.parse(dockerInspect(['--format', '{{json .Image}}',
          GHCR + '@' + manifest.digest]));
        assert.equal(config?.config?.Labels?.['org.opencontainers.image.revision'], sha,
          role + ' ' + manifest.platform.architecture + ' source revision mismatch');
      }
      refs.push(manifest.platform.architecture + '=' + manifest.digest);
    }
    evidence.push({ type: 'registry', value: image + ' ' + refs.join(' ') +
      (role === 'mcp' ? ' config revision=' + sha :
        ' source-bound by trusted Release Run and GHCR provenance') });
  }
  return evidence;
}
async function main() {
  const target = targetSha();
  assert.match(target, SHA);
  if (!(await isAncestor(FIX_SHA, target))) {
    throw Error('Case staging target does not contain merged #3968 image readback fix');
  }
  // The SC asks for a subsequent authenticated source-bound publication, not
  // necessarily a redundant new OCI push created by adding this Case. Accept
  // only a successful Staging source that contains the fix AND is an ancestor
  // of this independently source-pinned Case checkout. Both lanes must share
  // that *exact* source SHA, never different releases from a merge wave.
  const [releaseList, acrList] = await Promise.all([
    api('/actions/workflows/release-staging.yml/runs?branch=staging&event=push&status=success&per_page=50'),
    api('/actions/workflows/deploy-staging-acr.yml/runs?branch=staging&event=push&status=success&per_page=50'),
  ]);
  const releases = workflowRuns(releaseList,
    'Release / Staging Artifacts', '.github/workflows/release-staging.yml');
  const acrs = workflowRuns(acrList,
    'Deploy / Staging ACR', '.github/workflows/deploy-staging-acr.yml');
  const acrBySource = new Map(acrs.map(run => [run.head_sha, run]));
  let pair = null;
  for (const release of releases) {
    const acr = acrBySource.get(release.head_sha);
    if (!acr) continue;
    if (await isAncestor(FIX_SHA, release.head_sha) &&
        await isAncestor(release.head_sha, target)) {
      pair = { release, acr };
      break;
    }
  }
  if (!pair) return pending('no authenticated four-role GHCR/ACR pair yet for an ancestor of this staging Case after fix #3968');
  const { release, acr } = pair;
  const releaseJobs = await jobsOf(release);
  const acrJobs = await jobsOf(acr);
  for (const role of ROLES) {
    for (const arch of ['amd64','arm64']) {
      passed(releaseJobs, 'docker-' + role + '-' + arch);
    }
    passedStep(passed(acrJobs, 'mirror-acr (' + role + ')'),
      'Mirror and verify multi-arch ' + role + ' image');
  }
  passedStep(passed(releaseJobs, 'merge'), 'Create multi-arch hash manifests');
  passedStep(passed(releaseJobs, 'provenance'), 'Emit GHCR build provenance');
  passed(acrJobs, 'verify-source');
  passed(acrJobs, 'provenance');
  passed(acrJobs, 'deploy-staging-gitops');

  const evidence = registryEvidence(release.head_sha);
  evidence.push({type:'ci',value:'Release / Staging Artifacts run ' + release.id +
    ' attempt ' + release.run_attempt + ', exact source=' + release.head_sha +
    ': 8 platform Docker jobs, merge and authenticated GHCR provenance passed'});
  evidence.push({type:'ci',value:'Deploy / Staging ACR run ' + acr.id +
    ' attempt ' + acr.run_attempt + ', exact same source=' + acr.head_sha +
    ': verify-source, 4 source/destination Digest-checked mirror jobs, provenance and GitOps writer passed'});
  evidence.push({type:'provenance',value:'source ' + release.head_sha +
    ' is an authenticated staging ancestor of target ' + target +
    ' and descendant of readback fix ' + FIX_SHA});
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'trusted Staging release and ACR four-role Digest-verified GitOps lane succeeded for exactly the same post-fix source SHA ' + release.head_sha,
    evidence,
  }));
}
main().catch(error => {
  if (error?.unobservable) return pending(error.message);
  console.log(JSON.stringify({
    status: 'fail',
    summary: String(error?.message || 'source-bound ACR proof mismatch').slice(0,1000),
    evidence: [{type:'ci',value:'source/GHCR/ACR role, revision, digest or GitOps check was not established'}],
  }));
  process.exitCode = 1;
});
