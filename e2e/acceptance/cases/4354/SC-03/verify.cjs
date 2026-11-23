'use strict';
// #4354 SC-03: an authorized Staging Deploy / Identity run attests the exact
// deployed source with matching UI/Agent/Server immutable digests, source
// Run/Job/SHA evidence and trusted readback. GHCR is the sole GitOps deployment
// registry since #4032; the legacy ACR witness belongs to #3953/#3964 only.
//
// Trust model (#1974): Case/target code receives NO credentials, so this
// verifier performs no network reads at all. The trusted "Resolve trusted
// deployment binding" step in acceptance-cases.yml pre-stages the pinned
// acceptance-results store at ${RUNNER_TEMP}/acceptance-store and the selected
// binding at ${RUNNER_TEMP}/deployment-binding.json (DEPLOYMENT_BINDING env).
// The append-only Store is the only authority for deployed proof: its records
// were written by the trusted Deploy / Identity ingester after authenticating
// the source Run/Attempt/SHA. This Case verifies those immutable staged bytes,
// cross-checks them against the trusted binding, and binds the fix invariant
// to its own target-SHA checkout (targetSha() asserts HEAD == target SHA).
// No registry writes, no kubectl actions, no GitHub API quota dependence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { targetSha } = require('../../../shared/mcp-cases.cjs');

const REPO = 'BestNathan/nession';
const REGISTRY = 'ghcr.io/bestnathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEPLOYED = ['agent', 'server', 'ui'];
const RECORD_PATH = /^runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/staging\.json$/;
const INDEX_NAME = /^\d+-\d+-staging\.json$/;
// The canonical #4354 fix invariant: the collector binds pod imageIDs only
// after the desired revision has fully rolled out. Asserting these exact
// strings in the collector source at the deployed SHA binds the attested
// deployment to the fixed source without a circular same-PR SHA pin.
const FIX_INVARIANTS = [
  'deployment rollout has not converged to the desired template',
  'deployment.status?.updatedReplicas !== desiredReplicas',
];

const safe = x => String(x ?? '').replace(/[^A-Za-z0-9 .,_:/@()-]/g, ' ').slice(0, 170);

function rolesExactly(list, expected, label) {
  assert.ok(Array.isArray(list), label + ' must be an array');
  assert.deepEqual(list.map(x => x.role).sort(), [...expected].sort(),
    label + ' must include exactly the required roles');
}

// The trusted binding is the workflow's selection receipt: it must attest the
// exact target source in the staging lane and name one immutable store record.
function validateBinding(binding, sha) {
  assert.match(sha, SHA);
  assert.equal(binding.attested, true, 'binding must be an attested selection');
  assert.equal(binding.environment_id, 'staging');
  assert.equal(binding.source_sha, sha,
    'binding must select the exact deployed target source');
  assert.ok(typeof binding.attestation_path === 'string' &&
    RECORD_PATH.test(binding.attestation_path),
    'binding must name a canonical staging deployment record path');
  assert.match(binding.attestation_execution_id, /^[0-9a-f]{64}$/);
  assert.match(binding.gitops_revision, SHA);
  assert.ok(binding.image_digests && typeof binding.image_digests === 'object' &&
    !Array.isArray(binding.image_digests), 'binding image_digests must be a map');
  assert.deepEqual(Object.keys(binding.image_digests).sort(), [...DEPLOYED].sort(),
    'binding must carry exactly the deployed role digests');
  for (const role of DEPLOYED) {
    assert.match(binding.image_digests[role], DIGEST,
      'binding digest for ' + role);
  }
}

// The binding and the staged store bytes must describe the same observation.
function bindingCrossCheck(binding, index, digests) {
  assert.equal(binding.attestation_execution_id, index.execution_id,
    'binding must select the staged attestation execution');
  assert.equal(binding.gitops_revision, index.gitops_revision,
    'binding GitOps revision must match the staged attestation');
  for (const role of DEPLOYED) {
    assert.equal(binding.image_digests[role], digests.get(role),
      'binding digest for ' + role + ' must match the staged attestation');
  }
}

// Exactly one staged index may carry the binding's execution id; zero or many
// is an ambiguous/unreadable store and must fail closed, never guess.
function pickIndex(indexes, executionId) {
  const matches = indexes.filter(x => x.execution_id === executionId);
  assert.equal(matches.length, 1,
    'exactly one staged deployment index must match the binding execution');
  return matches[0];
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
  const data = attestation(idx, record, sha);
  assert.equal(data.sourceRun, 101);
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
  // Trusted-binding regressions (#4354 SC-03 deployed lane): the binding must
  // attest the exact target source, name one canonical staging record, and
  // agree with the staged attestation bytes. A forged, stale or mismatched
  // selection must fail closed.
  const binding = { attested: true, environment_id: 'staging', source_sha: sha,
    attestation_path: 'runs/2026-11-24/101-1/deployment/staging.json',
    attestation_execution_id: idx.execution_id, gitops_revision: gitops,
    image_digests: Object.fromEntries(DEPLOYED.map(role => [role, digest])) };
  validateBinding(binding, sha);
  bindingCrossCheck(binding, idx, data.digests);
  function rejectsBinding(fn) {
    const copy = structuredClone(binding);
    fn(copy);
    assert.throws(() => validateBinding(copy, sha));
  }
  rejectsBinding(x => { x.attested = false; });
  rejectsBinding(x => { x.environment_id = 'staging-01'; });
  rejectsBinding(x => { x.source_sha = 'f'.repeat(40); });
  rejectsBinding(x => { x.attestation_path = '../../etc/passwd'; });
  rejectsBinding(x => { x.attestation_path =
    'runs/2026-11-24/101-1/deployment/staging-01.json'; });
  rejectsBinding(x => { x.attestation_execution_id = 'not-an-execution-id'; });
  rejectsBinding(x => { x.gitops_revision = 'main'; });
  rejectsBinding(x => { delete x.image_digests.ui; });
  rejectsBinding(x => { x.image_digests.ui = 'sha256:short'; });
  rejectsBinding(x => { x.image_digests.extra = digest; });
  function rejectsCrossCheck(fn) {
    const copy = structuredClone(binding);
    fn(copy);
    assert.throws(() => bindingCrossCheck(copy, idx, data.digests));
  }
  rejectsCrossCheck(x => { x.attestation_execution_id = 'f'.repeat(64); });
  rejectsCrossCheck(x => { x.gitops_revision = 'f'.repeat(40); });
  rejectsCrossCheck(x => { x.image_digests.ui = 'sha256:' + 'f'.repeat(64); });
  // Index selection must be unambiguous: zero or duplicate executions fail.
  assert.equal(pickIndex([idx], idx.execution_id), idx);
  assert.throws(() => pickIndex([], idx.execution_id));
  assert.throws(() => pickIndex([idx, structuredClone(idx)], idx.execution_id));
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function verify() {
  fixtures();
  const sha = targetSha();
  // The deployed lane must hand this Case the trusted selection receipt;
  // absence is a lane misconfiguration, not a retryable observation gap.
  const bindingPath = process.env.DEPLOYMENT_BINDING;
  assert.ok(bindingPath,
    'deployed lane must provide DEPLOYMENT_BINDING from the trusted deployment step');
  const binding = readJson(bindingPath);
  validateBinding(binding, sha);
  // acceptance-cases.yml stages the pinned store as the binding's sibling
  // directory "acceptance-store" under RUNNER_TEMP; a layout change fails
  // closed here rather than silently reading other bytes.
  const storeRoot = path.resolve(path.dirname(bindingPath), 'acceptance-store');
  assert.ok(fs.existsSync(storeRoot),
    'trusted staged acceptance-store must exist beside the deployment binding');
  const recordPath = path.resolve(storeRoot, binding.attestation_path);
  assert.ok(recordPath.startsWith(storeRoot + path.sep),
    'attestation record must stay inside the staged store');
  const record = readJson(recordPath);
  const indexDir = path.join(storeRoot, 'indexes', 'by-sha', sha, 'deployment');
  const names = fs.readdirSync(indexDir).filter(x => INDEX_NAME.test(x));
  assert.ok(names.length > 0 && names.length <= 80,
    'staged deployment index directory must be bounded and non-empty');
  const indexes = names.map(x => readJson(path.join(indexDir, x)));
  const index = pickIndex(indexes, binding.attestation_execution_id);
  assert.equal(index.record, binding.attestation_path,
    'staged index must point at the binding-selected record');
  const data = attestation(index, record, sha);
  bindingCrossCheck(binding, index, data.digests);
  // Bind the attested deployment to the fixed collector source: the exact
  // deployed SHA checkout (HEAD == target SHA, asserted by targetSha()) must
  // contain the canonical converged-rollout invariant.
  const repoRoot = path.resolve(__dirname, '../../../../..');
  const collector = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'deployment-identity-collect.mjs'), 'utf8');
  for (const invariant of FIX_INVARIANTS) {
    assert.ok(collector.includes(invariant),
      'deployed source must contain the #4354 converged-rollout invariant');
  }
  const digests = [...data.digests].map(([role, digest]) =>
    role + '=' + digest).join(' ');
  return { status: 'pass',
    summary: 'authorized Staging Deploy / Identity attested exact source ' + sha +
      ' with matching GHCR UI/Agent/Server digests and trusted staged readback',
    evidence: [
      { type: 'provenance', value: 'trusted staged store record ' +
        binding.attestation_path + ' execution ' + index.execution_id +
        ' source ' + sha + ' GitOps ' + data.gitops },
      { type: 'ci', value: 'ingester-authenticated Deploy / Identity run ' +
        data.sourceRun + '/' + data.sourceAttempt +
        ' (workflow_run, main) recorded as Attested in the append-only store' },
      { type: 'runtime', value: 'staged remote samples verify ready ' +
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
    process.stdout.write(JSON.stringify({ status: 'fail',
      summary: '4354 deployed identity Case rejected: ' + safe(e.message),
      evidence: [] }) + '\n');
    process.exitCode = 1;
  });
}