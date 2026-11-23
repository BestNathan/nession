'use strict';
// #4354 SC-03: an authorized Staging Deploy / Identity run attests the exact
// deployed source with matching UI/Agent/Server immutable digests, source
// Run/Job/SHA evidence and trusted readback. GHCR is the sole GitOps deployment
// registry since #4032; the legacy ACR witness belongs to #3953/#3964 only.
// No registry writes or kubectl actions: this is an independent read-only
// cross-check. GitHub reads use the trusted runner's own read-only workflow
// token when present (hosted-runner egress IPs exhaust the unauthenticated
// quota, #4354 SC-03 first deployed run); without a token the public read path
// is unchanged. The trusted deployed Acceptance runner remains the only
// authoritative writer of the deployment-linked Acceptance record.
const assert = require('node:assert/strict');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const REGISTRY = 'ghcr.io/bestnathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEPLOYED = ['agent', 'server', 'ui'];
// The canonical #4354 fix invariant: the collector binds pod imageIDs only
// after the desired revision has fully rolled out. Asserting these exact
// strings in the collector source at the deployed SHA binds the attested
// deployment to the fixed source without a circular same-PR SHA pin.
const FIX_INVARIANTS = [
  'deployment rollout has not converged to the desired template',
  'deployment.status?.updatedReplicas !== desiredReplicas',
];

class Unobservable extends Error {}
const safe = x => String(x ?? '').replace(/[^A-Za-z0-9 .,_:/@()-]/g, ' ').slice(0, 170);

// Canonical read-only receipt pattern (e.g. 3082/SC-07): the harness passes
// the workflow environment through, so use its read-only token for API
// reads instead of the shared hosted-runner unauthenticated quota.
function apiHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json',
    'User-Agent': 'nession-4354-deployed-identity-case' };
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}
const allowedRev = rev => SHA.test(rev) || rev === 'acceptance-results';
async function get(route) {
  const headers = apiHeaders(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  let response;
  try {
    response = await fetch(API + route, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Unobservable('read-only GitHub evidence temporarily unavailable');
  }
  if (!response.ok) {
    if ([403, 404, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Unobservable('source-aligned deployment evidence not yet readable');
    }
    throw Error('unexpected GitHub read status ' + response.status);
  }
  return response.json();
}

function rolesExactly(list, expected, label) {
  assert.ok(Array.isArray(list), label + ' must be an array');
  assert.deepEqual(list.map(x => x.role).sort(), [...expected].sort(),
    label + ' must include exactly the required roles');
}

// Immutable source -> digest -> ready-workload chain, GHCR-authoritative.
function attestation(index, record, sha) {
  assert.match(sha, SHA);
  assert.equal(index.schema_version, 1);
  assert.equal(index.mode, 'deployment');
  assert.equal(index.environment_id, 'staging');
  assert.equal(index.target_sha, sha);
  assert.match(index.gitops_revision, SHA);
  assert.match(index.execution_id, /^[0-9a-f]{64}$/);
  assert.equal(index.source.repository, REPO);
  assert.equal(record.schema_version, 1);
  assert.equal(record.kind, 'nession_deployment_attestation');
  assert.equal(record.status, 'Attested');
  assert.equal(record.environment_id, 'staging');
  assert.equal(record.source_sha, sha);
  assert.equal(record.gitops_revision, index.gitops_revision);
  assert.equal(record.execution_id, index.execution_id);
  assert.ok(Number.isFinite(Date.parse(record.observed_at)));
  const source = record.provenance?.verified_source;
  for (const key of ['repository', 'run_id', 'run_attempt', 'workflow_id',
    'head_sha', 'head_branch']) {
    assert.equal(source?.[key], index.source[key],
      'immutable Deploy Identity Run provenance ' + key);
  }
  assert.equal(source.event, 'workflow_run');
  assert.equal(source.head_branch, 'main');
  rolesExactly(record.images, DEPLOYED, 'observed image roles');
  rolesExactly(record.workloads, DEPLOYED, 'ready workloads');
  const digests = new Map();
  for (const image of record.images) {
    assert.equal(image.declared_repository, REGISTRY);
    assert.equal(image.repository, REGISTRY,
      'a non-GHCR registry is not the deployed source');
    assert.equal(image.tag, image.role + '-' + sha.slice(0, 7));
    assert.match(image.digest, DIGEST);
    digests.set(image.role, image.digest);
  }
  for (const workload of record.workloads) {
    assert.equal(workload.ready, true);
    assert.equal(workload.namespace, 'nession');
    assert.equal(workload.name, 'nession-' + workload.role + '-staging');
    assert.ok(typeof workload.uid === 'string' && workload.uid.length > 10);
    assert.ok(Number.isSafeInteger(workload.generation) && workload.generation > 0);
    assert.equal(workload.observed_generation, workload.generation);
    assert.equal(workload.repository, REGISTRY);
    assert.equal(workload.digest, digests.get(workload.role));
    assert.equal(workload.image,
      REGISTRY + ':' + workload.role + '-' + sha.slice(0, 7));
    assert.equal(workload.image_id, REGISTRY + '@' + digests.get(workload.role));
  }
  const remote = record.remote_observation;
  assert.equal(remote?.kind, 'nession_remote_staging_observation');
  assert.equal(remote.status, 'Observed');
  assert.equal(remote.evaluation, null);
  assert.equal(remote.source_sha, sha);
  assert.equal(remote.gitops_revision, index.gitops_revision);
  assert.ok(Array.isArray(remote.samples) && remote.samples.length > 0);
  for (const sample of remote.samples) {
    rolesExactly(sample.workloads, DEPLOYED, 'remote workload samples');
    for (const workload of sample.workloads) {
      assert.equal(workload.ready, true);
      assert.equal(workload.generation, workload.observed_generation);
      assert.equal(workload.digest, digests.get(workload.role));
    }
  }
  return { gitops: index.gitops_revision, digests, sourceRun: source.run_id,
    sourceAttempt: source.run_attempt, observed: record.observed_at };
}

function fixtures() {
  const sha = 'a'.repeat(40);
  const digest = 'sha256:' + 'b'.repeat(64);
  const gitops = 'c'.repeat(40);
  const images = DEPLOYED.map(role => ({ role, declared_repository: REGISTRY,
    repository: REGISTRY, tag: role + '-aaaaaaa', digest }));
  const workloads = DEPLOYED.map(role => ({ role, ready: true, namespace: 'nession',
    name: 'nession-' + role + '-staging', uid: 'uuid-1234567890-' + role,
    generation: 2, observed_generation: 2, repository: REGISTRY, digest,
    image: REGISTRY + ':' + role + '-aaaaaaa', image_id: REGISTRY + '@' + digest }));
  const source = { repository: REPO, run_id: 101, run_attempt: 1, workflow_id: 99,
    head_sha: 'd'.repeat(40), head_branch: 'main', event: 'workflow_run' };
  const idx = { schema_version: 1, mode: 'deployment', environment_id: 'staging',
    target_sha: sha, gitops_revision: gitops, execution_id: 'e'.repeat(64),
    source: { ...source } };
  const record = { schema_version: 1, kind: 'nession_deployment_attestation',
    status: 'Attested', environment_id: 'staging', source_sha: sha,
    gitops_revision: gitops, execution_id: idx.execution_id,
    observed_at: '2026-11-24T00:00:00Z', images, workloads,
    provenance: { verified_source: { ...source } },
    remote_observation: { kind: 'nession_remote_staging_observation',
      status: 'Observed', evaluation: null, source_sha: sha, gitops_revision: gitops,
      samples: [{ workloads: DEPLOYED.map(role => ({
        role, ready: true, generation: 2, observed_generation: 2, digest })) }] } };
  assert.equal(attestation(idx, record, sha).sourceRun, 101);
  function rejects(fn) {
    const copy = structuredClone(record);
    fn(copy);
    assert.throws(() => attestation(idx, copy, sha));
  }
  // A stale/mirror registry, missing role, unready workload, foreign imageID,
  // stale generation, drifted sample digest, forged source or provenance must
  // all fail closed — the incident's old-revision witness must never attest.
  rejects(x => { x.images[0].repository = 'registry.example.com/acr'; });
  rejects(x => { x.images[0].declared_repository = 'registry.example.com/acr'; });
  rejects(x => { x.images.pop(); });
  rejects(x => { x.workloads[0].ready = false; });
  rejects(x => { x.workloads[1].image_id = 'registry.example.com@' + digest; });
  rejects(x => { x.workloads[2].observed_generation = 1; });
  rejects(x => { x.remote_observation.samples[0].workloads[0].digest =
    'sha256:' + 'f'.repeat(64); });
  rejects(x => { x.source_sha = 'f'.repeat(40); });
  rejects(x => { x.provenance.verified_source.run_id = 102; });
  rejects(x => { x.remote_observation.evaluation = 'Pass'; });
  // Live-readback regressions (first deployed run, #4354 SC-03): the store
  // ref must be readable and the runner's read-only token must authenticate
  // API reads; hosted-runner unauthenticated quota alone returns Pending.
  assert.equal(allowedRev(sha), true);
  assert.equal(allowedRev('acceptance-results'), true);
  assert.equal(allowedRev('main'), false);
  assert.equal(allowedRev(''), false);
  assert.equal(allowedRev(sha.slice(0, 39)), false);
  assert.equal(apiHeaders('').Authorization, undefined);
  assert.equal(apiHeaders(undefined).Authorization, undefined);
  assert.equal(apiHeaders('read-only-token').Authorization,
    'Bearer read-only-token');
  // The fix-invariant source binding rejects a pre-fix collector source.
  const preFix = 'function deploymentFor() { return availableReplicas >= 1; }';
  for (const invariant of FIX_INVARIANTS) {
    assert.equal(preFix.includes(invariant), false);
  }
  const fixed = FIX_INVARIANTS.join('\n');
  for (const invariant of FIX_INVARIANTS) {
    assert.equal(fixed.includes(invariant), true);
  }
}

async function fileAt(path, rev) {
  assert.ok(allowedRev(rev),
    'only an immutable source SHA or canonical deployment-store ref is allowed');
  const file = await get('/contents/' + path + '?ref=' + rev);
  assert.equal(file.type, 'file');
  assert.equal(file.encoding, 'base64');
  assert.ok(typeof file.content === 'string' && file.content.length < 120000);
  return Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
}
async function jsonAt(path, rev) {
  return JSON.parse(await fileAt(path, rev));
}
function passed(jobs, name, step) {
  const matches = jobs.filter(x => x.name === name);
  assert.equal(matches.length, 1, 'exactly one trusted job ' + name);
  const job = matches[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  if (step) {
    assert.equal((job.steps ?? []).filter(x =>
      x.name === step && x.status === 'completed' && x.conclusion === 'success').length,
      1, name + ' must complete ' + step);
  }
  return job;
}
async function jobsOf(run) {
  const x = await get('/actions/runs/' + run.id + '/attempts/' + run.run_attempt +
    '/jobs?per_page=100');
  assert.ok(Array.isArray(x.jobs) && x.jobs.length > 0 && x.jobs.length <= 100);
  return x.jobs;
}
async function deployedAttestation(sha) {
  const list = await get('/contents/indexes/by-sha/' + sha +
    '/deployment?ref=acceptance-results');
  assert.ok(Array.isArray(list) && list.length <= 80);
  const entries = list.filter(x => /^\d+-\d+-staging\.json$/.test(x.name) &&
    x.type === 'file').slice(0, 12);
  if (!entries.length) throw new Unobservable('identity not yet ingested');
  const all = [];
  for (const entry of entries) {
    const index = await jsonAt(entry.path, 'acceptance-results');
    assert.ok(/^runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/staging\.json$/
      .test(index.record), 'unsafe attestation record path');
    const record = await jsonAt(index.record, 'acceptance-results');
    const data = attestation(index, record, sha);
    all.push({ index, record, data });
  }
  all.sort((a, b) => Date.parse(b.data.observed) - Date.parse(a.data.observed));
  if (all.length > 1 && all[0].data.observed === all[1].data.observed) {
    throw Error('ambiguous latest identity observation');
  }
  const chosen = all[0];
  const run = await get('/actions/runs/' + chosen.data.sourceRun);
  assert.equal(run.name, 'Deploy / Identity');
  assert.equal(run.path?.split('@')[0], '.github/workflows/deploy-identity.yml');
  assert.equal(run.event, 'workflow_run');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.run_attempt, chosen.data.sourceAttempt);
  passed(await jobsOf(run), 'attest',
    'Wait boundedly for reconciled Staging workload identity');
  return chosen;
}
async function verify() {
  fixtures();
  const sha = targetSha();
  // Bind the attested deployment to the fixed collector source: the exact
  // deployed SHA must contain the canonical converged-rollout invariant.
  const collector = await fileAt('scripts/deployment-identity-collect.mjs', sha);
  for (const invariant of FIX_INVARIANTS) {
    assert.ok(collector.includes(invariant),
      'deployed source must contain the #4354 converged-rollout invariant');
  }
  const observed = await deployedAttestation(sha);
  const digests = [...observed.data.digests].map(([role, digest]) =>
    role + '=' + digest).join(' ');
  return { status: 'pass',
    summary: 'authorized Staging Deploy / Identity attested exact source ' + sha +
      ' with matching GHCR UI/Agent/Server digests and trusted readback',
    evidence: [
      { type: 'provenance', value: 'immutable deployed receipt ' +
        observed.index.record + ' execution ' + observed.index.execution_id +
        ' source ' + sha + ' GitOps ' + observed.data.gitops },
      { type: 'ci', value: 'trusted successful Deploy / Identity run ' +
        observed.data.sourceRun + '/' + observed.data.sourceAttempt +
        ' attest completed the bounded reconciled-identity wait' },
      { type: 'runtime', value: 'read-only remote samples verify ready ' +
        'GHCR workloads and immutable role digests: ' + digests },
      { type: 'runtime', value: 'collector source at deployed SHA ' + sha +
        ' contains the #4354 converged-rollout invariant; the trusted runner ' +
        'must separately validate environment=staging and exact SHA binding' },
    ] };
}
if (process.argv.includes('--self-test')) {
  fixtures();
  process.stdout.write('4354 deployed identity Case offline mutation fixtures passed\n');
} else {
  verify().then(v => process.stdout.write(JSON.stringify(v) + '\n')).catch(e => {
    const pending = e instanceof Unobservable;
    process.stdout.write(JSON.stringify({ status: pending ? 'pending' : 'fail',
      summary: pending ? safe(e.message) : '4354 deployed identity Case rejected: ' + safe(e.message),
      evidence: [] }) + '\n');
    if (!pending) process.exitCode = 1;
  });
}