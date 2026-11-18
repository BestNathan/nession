'use strict';
// #3791 SC-03: the source-pinned staging release publishes a resolvable
// mcp-<short-sha> GHCR multi-arch index whose platform images bind the exact
// source SHA, and the authenticated ACR lane mirrors the MCP role.
//
// Read-only and anonymous: no Actions token is available to target Case code.
// GHCR is read through Docker's registry client (`buildx imagetools`), the
// same tool the release lane uses; raw anonymous manifest requests from
// shared hosted-runner IPs proved unreliable (spurious 404). Anonymous GitHub
// API rate limiting is unobservability, not a negative product fact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const GHCR = 'ghcr.io/bestnathan/nession';
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^sha256:[a-f0-9]{64}$/;
const RELEASE_JOBS = [
  'docker-server-amd64', 'docker-agent-amd64', 'docker-mcp-amd64', 'docker-ui-amd64',
  'docker-server-arm64', 'docker-agent-arm64', 'docker-mcp-arm64', 'docker-ui-arm64',
];
const repoRoot = path.resolve(__dirname, '../../../../..');

async function api(route) {
  const response = await fetch(API + route, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nession-3791-case' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = new Error('GitHub source lookup unavailable: HTTP ' +
      response.status + ' ' + route);
    if (response.status === 403 || response.status === 429) error.unobservable = true;
    throw error;
  }
  return response.json();
}

function matchingRuns(runs, { workflow, name, sha }) {
  return (runs.workflow_runs ?? []).filter((item) =>
    item.path?.split('@')[0] === workflow && item.name === name &&
    item.head_sha === sha && item.head_branch === 'staging' &&
    item.event === 'push' && item.repository?.full_name === REPO &&
    item.head_repository?.full_name === REPO).sort((a, b) =>
    (b.run_number ?? 0) - (a.run_number ?? 0) ||
    (b.run_attempt ?? 0) - (a.run_attempt ?? 0) ||
    (b.id ?? 0) - (a.id ?? 0));
}

function selectRun(runs, { workflow, name, sha }) {
  const selected = matchingRuns(runs, { workflow, name, sha })[0];
  if (!selected) return { pending: name + ' run has not started for staging ' + sha };
  if (selected.status !== 'completed') {
    return { pending: name + ' run ' + selected.id + ' is still ' + selected.status };
  }
  if (selected.conclusion !== 'success') {
    throw new Error(name + ' run ' + selected.id + ' concluded ' + selected.conclusion);
  }
  return { run: selected };
}

function pendingResult(reason) {
  console.log(JSON.stringify({ status: 'pending', summary: reason, evidence: [] }));
}

async function jobsOf(run) {
  const body = await api('/actions/runs/' + run.id + '/attempts/' + run.run_attempt +
    '/jobs?per_page=100');
  assert.ok(Array.isArray(body.jobs) && body.jobs.length > 0 && body.jobs.length <= 100,
    'bounded job inventory required for run ' + run.id);
  return body.jobs;
}

function succeededJob(jobs, name) {
  const found = jobs.filter((job) => job.name === name);
  assert.equal(found.length, 1, 'missing or duplicated job ' + name);
  assert.equal(found[0].status, 'completed', 'job ' + name + ' is not completed');
  assert.equal(found[0].conclusion, 'success', 'job ' + name + ' is not successful');
  return found[0];
}

function succeededStep(job, name) {
  const passed = (job.steps ?? []).filter((step) =>
    step.name === name && step.status === 'completed' && step.conclusion === 'success');
  assert.equal(passed.length, 1, 'missing successful step ' + name + ' in ' + job.name);
}

function docker(args, timeout = 150000) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function collectRegistry(targetSha, shortSha) {
  const imageRef = GHCR + ':mcp-' + shortSha;
  const manifest = JSON.parse(docker(['buildx', 'imagetools', 'inspect',
    '--format', '{{json .Manifest}}', imageRef]));
  assert.match(manifest?.digest ?? '', HEX64, 'registry must return an immutable index digest');
  const index = JSON.parse(docker(['buildx', 'imagetools', 'inspect', '--raw', imageRef]));
  const platforms = (index.manifests ?? []).filter((item) =>
    item.platform?.os === 'linux' &&
    (item.platform?.architecture === 'amd64' || item.platform?.architecture === 'arm64'));
  assert.deepEqual(platforms.map((item) => item.platform.architecture).sort(),
    ['amd64', 'arm64'], 'mcp-' + shortSha + ' must have exactly amd64 and arm64');
  const out = {};
  for (const platform of platforms) {
    assert.match(platform.digest, HEX64);
    const config = JSON.parse(docker(['buildx', 'imagetools', 'inspect',
      '--format', '{{json .Image}}', GHCR + '@' + platform.digest]));
    assert.equal(config?.config?.Labels?.['org.opencontainers.image.revision'], targetSha,
      platform.platform.architecture + ' image revision must equal the target SHA');
    out[platform.platform.architecture] = { digest: platform.digest, revision: targetSha };
  }
  return { index_digest: manifest.digest, platforms: out };
}

async function main() {
  const sha = targetSha();
  assert.match(sha, HEX40);
  const shortSha = sha.slice(0, 7);

  const releaseRuns = await api('/actions/workflows/release-staging.yml/runs?head_sha=' +
    sha + '&per_page=100');
  const releaseSelection = selectRun(releaseRuns, {
    workflow: '.github/workflows/release-staging.yml',
    name: 'Release / Staging Artifacts', sha,
  });
  if (releaseSelection.pending) return pendingResult(releaseSelection.pending);
  const release = releaseSelection.run;
  const releaseJobs = await jobsOf(release);
  for (const name of [...RELEASE_JOBS, 'merge', 'provenance']) {
    succeededJob(releaseJobs, name);
  }
  succeededStep(succeededJob(releaseJobs, 'merge'), 'Create multi-arch hash manifests');
  succeededStep(succeededJob(releaseJobs, 'provenance'), 'Emit GHCR build provenance');

  const registry = collectRegistry(sha, shortSha);

  // The authenticated ACR lane mirrors the MCP role. The lane is
  // snapshot-bound and refuses a stale SHA after staging moves, so the
  // exact-SHA success is preferred; otherwise a real successful staging lane
  // that completed the MCP role with provenance and GitOps deployment is
  // required, and its source SHA is recorded.
  const acrWorkflow = {
    workflow: '.github/workflows/deploy-staging-acr.yml',
    name: 'Deploy / Staging ACR',
  };
  const exactAcr = matchingRuns(
    await api('/actions/workflows/deploy-staging-acr.yml/runs?head_sha=' + sha + '&per_page=100'),
    { ...acrWorkflow, sha },
  )[0];
  let acr;
  let acrSourceSha = null;
  if (exactAcr?.status === 'completed' && exactAcr.conclusion === 'success') {
    acr = exactAcr;
  } else {
    const recent = await api('/actions/workflows/deploy-staging-acr.yml/runs' +
      '?branch=staging&event=push&status=success&per_page=30');
    for (const run of (recent.workflow_runs ?? []).slice(0, 6)) {
      const jobs = await jobsOf(run);
      const mcpJob = jobs.find((job) => job.name === 'mirror-acr (mcp)');
      if (mcpJob?.status === 'completed' && mcpJob.conclusion === 'success') {
        acr = run;
        acrSourceSha = run.head_sha;
        break;
      }
    }
    if (!acr) {
      if (exactAcr && exactAcr.status !== 'completed') {
        return pendingResult(acrWorkflow.name + ' run ' + exactAcr.id + ' is still ' + exactAcr.status);
      }
      return pendingResult('no successful authenticated staging ACR lane with the MCP role is observable yet');
    }
  }
  const acrJobs = await jobsOf(acr);
  succeededStep(succeededJob(acrJobs, 'mirror-acr (mcp)'), 'Mirror and verify multi-arch mcp image');
  succeededJob(acrJobs, 'provenance');
  succeededJob(acrJobs, 'deploy-staging-gitops');

  // The canonical source verifier refuses a missing MCP artifact; its
  // self-test removes every required job, including both MCP jobs.
  const verifier = fs.readFileSync(path.join(repoRoot, 'scripts/ci/verify-staging-ghcr-source.mjs'), 'utf8');
  assert.ok(verifier.includes("'docker-mcp-amd64'") && verifier.includes("'docker-mcp-arm64'"),
    'staging source verifier does not require both MCP image jobs');
  const selfTest = execFileSync(process.execPath,
    [path.join(repoRoot, 'scripts/ci/verify-staging-ghcr-source.mjs'), 'self-test'],
    { encoding: 'utf8', timeout: 30000 });
  assert.match(selfTest, /ten jobs/, 'staging source verifier self-test did not cover ten jobs');

  console.log(JSON.stringify({
    status: 'pass',
    summary: 'staging release published mcp-' + shortSha +
      ' as a two-architecture index bound to the exact source SHA; the authenticated ACR lane mirrored the MCP role',
    evidence: [
      { type: 'ci', value: 'Release / Staging Artifacts run ' + release.id + ' attempt ' +
        release.run_attempt + ' published mcp ' + shortSha + ' from ' + sha },
      { type: 'registry', value: GHCR + ':mcp-' + shortSha + ' index ' +
        registry.index_digest + ' amd64=' + registry.platforms.amd64.digest +
        ' arm64=' + registry.platforms.arm64.digest + ' revision=' + sha },
      { type: 'provenance', value: 'both platform configs bind revision ' + sha +
        '; merge/provenance steps succeeded' },
      { type: 'ci', value: 'Deploy / Staging ACR run ' + acr.id + ' (' +
        (acrSourceSha ? 'lane at staging ' + acrSourceSha.slice(0, 7) : 'exact SHA') +
        ') mirrored the MCP role with provenance and GitOps deployment' },
      { type: 'runtime', value: 'staging source verifier requires both MCP jobs and its ten-job negative self-test passed' },
    ],
  }));
}

main().catch((error) => {
  if (error && error.unobservable) {
    pendingResult(String(error.message || error));
    return;
  }
  console.log(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'registry', value: 'the exact staging SHA has no verified MCP image/provenance receipt' }],
  }));
  process.exitCode = 1;
});
