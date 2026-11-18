'use strict';
// #3791 SC-03: the source-pinned staging release publishes a resolvable
// mcp-<short-sha> GHCR multi-arch index whose platform images bind the exact
// source SHA, and the authenticated ACR lane mirrored it. Read-only and
// anonymous: no Actions token is available to target Case code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { run, targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const GHCR = 'https://ghcr.io/bestnathan/nession';
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^sha256:[a-f0-9]{64}$/;

const repoRoot = path.resolve(__dirname, '../../../../..');

async function api(route) {
  const response = await fetch(API + route, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nession-3791-case' },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GitHub source lookup unavailable: HTTP ' + response.status + ' ' + route);
  return response.json();
}

function matchingRuns(runs, { workflow, name, sha }) {
  return (runs.workflow_runs ?? []).filter((item) =>
    item.path?.split('@')[0] === workflow && item.name === name &&
    item.head_sha === sha && item.head_branch === 'staging' &&
    item.event === 'push' && item.repository?.full_name === REPO).sort((a, b) =>
    (b.run_number ?? 0) - (a.run_number ?? 0) ||
    (b.run_attempt ?? 0) - (a.run_attempt ?? 0) ||
    (b.id ?? 0) - (a.id ?? 0));
}

function selectRun(runs, { workflow, name, sha }) {
  const selected = matchingRuns(runs, { workflow, name, sha })[0];
  // Publication is asynchronous with this Case. An absent or still-running
  // producer is Pending, never a fabricated Pass or a misleading Fail.
  if (!selected) return { pending: name + ' run has not started for staging ' + sha };
  if (selected.status !== 'completed') {
    return { pending: name + ' run ' + selected.id + ' is still ' + selected.status };
  }
  if (selected.conclusion !== 'success') {
    throw new Error(name + ' run ' + selected.id + ' concluded ' + selected.conclusion);
  }
  return { run: selected };
}

function pendingResult(pending) {
  console.log(JSON.stringify({
    status: 'pending',
    summary: pending + '; replay this Case after the staging release/ACR lanes complete',
    evidence: [],
  }));
}

async function jobsOf(run) {
  const body = await api('/actions/runs/' + run.id + '/attempts/' + run.run_attempt +
    '/jobs?per_page=100');
  assert.ok(Array.isArray(body.jobs) && body.jobs.length > 0 && body.jobs.length <= 100,
    'unbounded or empty job inventory for run ' + run.id);
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
  return passed[0];
}

async function registryToken() {
  const response = await fetch('https://ghcr.io/token?scope=repository:bestnathan/nession:pull', {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GHCR anonymous token unavailable: ' + response.status);
  const body = await response.json();
  assert.ok(typeof body.token === 'string' && body.token.length > 0, 'GHCR returned no pull token');
  return body.token;
}

async function manifest(token, reference, accept) {
  const response = await fetch(GHCR + '/manifests/' + reference, {
    headers: { Authorization: 'Bearer ' + token, Accept: accept },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GHCR manifest ' + reference + ' returned ' + response.status);
  return response.json();
}

async function blob(token, digest) {
  const response = await fetch(GHCR + '/blobs/' + digest, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('GHCR blob ' + digest + ' returned ' + response.status);
  return response.json();
}

async function main() {
  const sha = targetSha();
  assert.match(sha, HEX40);
  const ref = sha.slice(0, 7);
  assert.equal(process.env.GITHUB_REF_NAME, 'staging', 'this Case requires a staging push');

  const releaseRuns = await api('/actions/workflows/release-staging.yml/runs?head_sha=' + sha + '&per_page=100');
  const releaseSelection = selectRun(releaseRuns, {
    workflow: '.github/workflows/release-staging.yml',
    name: 'Release / Staging Artifacts', sha,
  });
  if (releaseSelection.pending) return pendingResult(releaseSelection.pending);
  const release = releaseSelection.run;
  const releaseJobs = await jobsOf(release);
  for (const role of ['server', 'agent', 'mcp', 'ui']) {
    succeededJob(releaseJobs, 'docker-' + role + '-amd64');
    succeededJob(releaseJobs, 'docker-' + role + '-arm64');
  }
  const merge = succeededJob(releaseJobs, 'merge');
  succeededStep(merge, 'Create multi-arch hash manifests');
  const provenance = succeededJob(releaseJobs, 'provenance');
  succeededStep(provenance, 'Emit GHCR build provenance');

  // Independently observable registry truth: the index and both platform
  // manifests exist, and each image config binds the exact source SHA.
  const token = await registryToken();
  const index = await manifest(token, 'mcp-' + ref,
    'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json');
  const platforms = (index.manifests ?? []).filter((item) =>
    item.platform?.os === 'linux' &&
    (item.platform?.architecture === 'amd64' || item.platform?.architecture === 'arm64'));
  assert.deepEqual(platforms.map((item) => item.platform.architecture).sort(),
    ['amd64', 'arm64'], 'mcp-' + ref + ' is not a two-architecture index');
  const digests = {};
  for (const platform of platforms) {
    assert.match(platform.digest, HEX64, 'invalid platform manifest digest');
    const image = await manifest(token, platform.digest,
      'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json');
    assert.match(image.config?.digest ?? '', HEX64, 'platform image has no config digest');
    const config = await blob(token, image.config.digest);
    assert.equal(config.config?.Labels?.['org.opencontainers.image.revision'], sha,
      platform.platform.architecture + ' image does not bind source revision ' + sha);
    digests[platform.platform.architecture] = platform.digest;
  }

  // The authenticated ACR lane mirrors the same role. Its success is
  // GitHub-owned run/job/step metadata, not Case-authored prose. The lane is
  // snapshot-bound: it refuses to advance GitOps after staging moves to
  // another SHA. In that supersession case the exact-SHA mirror cannot exist,
  // so the proof requires the same lane to mirror the MCP role at the current
  // staging head and records the supersession explicitly.
  const acrRuns = await api('/actions/workflows/deploy-staging-acr.yml/runs?head_sha=' + sha + '&per_page=100');
  const acrWorkflow = {
    workflow: '.github/workflows/deploy-staging-acr.yml',
    name: 'Deploy / Staging ACR',
  };
  const exactAcr = matchingRuns(acrRuns, { ...acrWorkflow, sha })[0];
  let acr;
  let acrSupersededBy = null;
  if (exactAcr?.status === 'completed' && exactAcr.conclusion === 'success') {
    acr = exactAcr;
  } else {
    const head = (await api('/branches/staging')).commit?.sha;
    assert.match(String(head || ''), HEX40, 'authenticated staging head is unavailable');
    if (head === sha) {
      if (!exactAcr) return pendingResult(acrWorkflow.name + ' run has not started for staging ' + sha);
      if (exactAcr.status !== 'completed') {
        return pendingResult(acrWorkflow.name + ' run ' + exactAcr.id + ' is still ' + exactAcr.status);
      }
      throw new Error(acrWorkflow.name + ' run ' + exactAcr.id + ' concluded ' + exactAcr.conclusion);
    }
    const headSelection = selectRun(
      await api('/actions/workflows/deploy-staging-acr.yml/runs?head_sha=' + head + '&per_page=100'),
      { ...acrWorkflow, sha: head },
    );
    if (headSelection.pending) {
      return pendingResult('ACR lane for superseding staging head ' + head.slice(0, 7) +
        ': ' + headSelection.pending);
    }
    acr = headSelection.run;
    acrSupersededBy = head;
  }
  const acrJobs = await jobsOf(acr);
  const mirrored = succeededJob(acrJobs, 'mirror-acr (mcp)');
  succeededStep(mirrored, 'Mirror and verify multi-arch mcp image');
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

  const indexResponse = await fetch(GHCR + '/manifests/mcp-' + ref, {
    method: 'HEAD',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(indexResponse.status, 200, 'GHCR mcp index is not resolvable');
  const indexDigest = indexResponse.headers.get('docker-content-digest');
  assert.match(indexDigest ?? '', HEX64, 'registry did not return an immutable mcp index digest');

  const acrEvidence = acrSupersededBy
    ? 'exact-SHA ACR lane was refused after staging advanced to ' +
      acrSupersededBy.slice(0, 7) + '; the same authenticated lane at ' +
      acrSupersededBy.slice(0, 7) + ' succeeded: run ' + acr.id +
      ' mirror-acr (mcp) + provenance + deploy-staging-gitops'
    : 'Deploy / Staging ACR run ' + acr.id +
      ': mirror-acr (mcp) + provenance + deploy-staging-gitops succeeded';
  console.log(JSON.stringify({
    status: 'pass',
    summary: 'staging release published mcp-' + ref + ' as a two-architecture GHCR index bound to the exact source SHA; the authenticated ACR lane mirrored the MCP role' +
      (acrSupersededBy ? ' at the superseding staging head ' + acrSupersededBy.slice(0, 7) : ''),
    evidence: [
      { type: 'ci', value: 'Release / Staging Artifacts run ' + release.id + ' attempt ' + release.run_attempt + ' published mcp ' + ref + ' from ' + sha },
      { type: 'registry', value: 'ghcr.io/bestnathan/nession:mcp-' + ref + ' index ' + indexDigest + ' platforms amd64=' + digests.amd64 + ' arm64=' + digests.arm64 },
      { type: 'provenance', value: 'both platform configs carry org.opencontainers.image.revision=' + sha + '; merge/provenance steps succeeded' },
      { type: 'ci', value: acrEvidence },
      { type: 'runtime', value: 'staging source verifier requires both MCP jobs and its ten-job negative self-test passed' },
    ],
  }));
}

main().catch((error) => {
  console.log(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'registry', value: 'the exact staging SHA has no verified MCP image/provenance receipt' }],
  }));
  process.exitCode = 1;
});
