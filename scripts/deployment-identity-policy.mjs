#!/usr/bin/env node
// Owner: #1616 deployment identity, consumed by #2323 lane acceptance and
// Staging Full scheduling. This module is a pure, fail-closed policy: it never
// reads GitOps, a registry or a cluster itself. Callers must supply trusted
// data, and partial/untrusted input must never become an attested identity.
//
// An attestation binds:
//   trusted GitOps overlay (environment id, namespace, workload names, tags)
//   trusted build provenance (full source SHA -> immutable image digests)
//   an observed ready workload (namespace, name, UID, generation, imageID)
// so `source_sha -> image digests -> observed ready workloads` is one chain.
import assert from 'node:assert/strict';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY = /^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/;
export const ROLES = Object.freeze(['agent', 'server', 'ui']);
export const OVERLAY_PATH = /^environments\/([a-z][a-z0-9-]{0,62})\/nession\/kustomization\.yaml$/;

function fail(message) {
  throw new Error(message);
}

function singleLine(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /[\r\n]/.test(text)) fail(label + ' must be a non-empty single line');
  return text;
}

function role(value, label) {
  const text = String(value ?? '');
  if (!ROLES.includes(text)) fail(label + ' is not an approved workload role');
  return text;
}

// Caller-nominated environment names are never authority. The trusted GitOps
// inventory is the allowlist.
export function resolveEnvironment(requested, trustedEnvironments) {
  const requestedId = String(requested ?? '');
  if (!ENVIRONMENT.test(requestedId)) fail('requested environment id is invalid');
  if (!Array.isArray(trustedEnvironments) || trustedEnvironments.length === 0) {
    fail('trusted environment inventory is required');
  }
  const inventory = new Set();
  for (const entry of trustedEnvironments) {
    if (!ENVIRONMENT.test(String(entry ?? ''))) fail('trusted environment inventory contains an invalid id');
    inventory.add(String(entry));
  }
  if (!inventory.has(requestedId)) {
    fail('environment ' + requestedId + ' is not registered in the trusted GitOps inventory');
  }
  return requestedId;
}

export function environmentOverlayPath(environmentId) {
  const id = String(environmentId ?? '');
  if (!ENVIRONMENT.test(id)) fail('environment id is invalid');
  return 'environments/' + id + '/nession/kustomization.yaml';
}

// The kustomize overlay is a small, trusted file. This intentionally parses
// only the fields identity depends on; it is not a general YAML implementation.
export function parseEnvironmentOverlay(path, text) {
  const match = String(path ?? '').match(OVERLAY_PATH);
  if (!match) fail('overlay path is not a trusted environment kustomization');
  const environmentId = match[1];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let namespace = null;
  let nameSuffix = '';
  let envLabel = null;
  const images = [];
  let section = null;
  let current = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (raw.includes('\t')) fail('overlay uses unsupported tab indentation');
    const top = raw.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
    if (top) {
      section = top[1];
      current = null;
      const value = (top[2] ?? '').trim();
      if (section === 'namespace') namespace = value;
      else if (section === 'nameSuffix') nameSuffix = value;
      continue;
    }
    if (section === 'commonLabels') {
      const label = raw.match(/^\s+([A-Za-z][A-Za-z0-9/._-]*):\s*(.*)$/);
      if (label && label[1] === 'env') envLabel = label[2].trim();
      continue;
    }
    if (section === 'images') {
      const item = raw.match(/^\s*-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
      if (item) {
        current = { [item[1]]: item[2].trim() };
        images.push(current);
        continue;
      }
      const field = raw.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
      if (field && current) {
        if (field[1] === 'name' || field[1] === 'newName' || field[1] === 'newTag') {
          current[field[1]] = field[2].trim();
        }
      }
    }
  }
  if (namespace === null || !singleLine(namespace, 'overlay namespace')) {
    fail('overlay must declare a namespace');
  }
  if (nameSuffix && !/^-[a-z0-9-]+$/.test(nameSuffix)) fail('overlay nameSuffix is invalid');
  const byRole = new Map();
  for (const image of images) {
    const base = String(image.name ?? '');
    const suffix = base.slice(base.lastIndexOf('/') + 1);
    const roleName = suffix.replace(/^nession-/, '');
    if (!ROLES.includes(roleName)) continue;
    if (byRole.has(roleName)) fail('overlay declares duplicate ' + roleName + ' image');
    const repository = singleLine(image.newName, roleName + ' overlay repository');
    if (!REPOSITORY.test(repository)) fail(roleName + ' overlay repository is invalid');
    const tag = singleLine(image.newTag, roleName + ' overlay tag');
    if (!TAG.test(tag)) fail(roleName + ' overlay tag is invalid');
    if (!tag.startsWith(roleName + '-')) fail(roleName + ' overlay tag is not role-scoped');
    byRole.set(roleName, { repository, tag });
  }
  for (const roleName of ROLES) {
    if (!byRole.has(roleName)) fail('overlay is missing the ' + roleName + ' image');
  }
  const expectedWorkloads = {};
  for (const roleName of ROLES) expectedWorkloads[roleName] = 'nession-' + roleName + nameSuffix;
  return {
    environment_id: environmentId,
    namespace,
    name_suffix: nameSuffix,
    env_label: envLabel,
    images: Object.fromEntries(ROLES.map((roleName) => [roleName, byRole.get(roleName)])),
    expected_workloads: expectedWorkloads,
  };
}

// Provenance is trusted build metadata (for example, an artifact emitted by the
// trusted release workflow). A short-SHA tag is only a naming convention, so it
// is cross-checked against the full source SHA rather than trusted as proof.
export function validateProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    fail('build provenance must be an object');
  }
  if (Number(provenance.schema_version) !== 1 || provenance.kind !== 'nession_build_provenance') {
    fail('unsupported build provenance schema');
  }
  const sourceSha = String(provenance.source_sha ?? '');
  if (!SHA.test(sourceSha)) fail('build provenance source_sha must be a 40-character hex SHA');
  const images = provenance.images;
  if (!images || typeof images !== 'object' || Array.isArray(images)) {
    fail('build provenance images must be an object');
  }
  const unknown = Object.keys(images).filter((key) => !ROLES.includes(key));
  if (unknown.length) fail('build provenance contains an unknown image role');
  const result = {};
  for (const roleName of ROLES) {
    const entry = images[roleName];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('build provenance is missing the ' + roleName + ' image');
    }
    const tag = singleLine(entry.tag, roleName + ' provenance tag');
    if (!TAG.test(tag)) fail(roleName + ' provenance tag is invalid');
    if (!tag.startsWith(roleName + '-')) fail(roleName + ' provenance tag is not role-scoped');
    const digest = singleLine(entry.digest, roleName + ' provenance digest');
    if (!DIGEST.test(digest)) fail(roleName + ' provenance digest is not an immutable sha256 digest');
    const short = tag.slice(roleName.length + 1);
    if (/^[0-9a-f]{7,40}$/.test(short) && !sourceSha.startsWith(short)) {
      fail(roleName + ' tag does not match the provenance source SHA');
    }
    result[roleName] = { tag, digest };
  }
  return { source_sha: sourceSha, images: result };
}

export function attestDeployment({ overlay, provenance, gitopsRevision, observation }) {
  if (!overlay || typeof overlay !== 'object') fail('trusted GitOps overlay is required');
  if (!ROLES.every((roleName) => overlay.images?.[roleName])) fail('trusted GitOps overlay is incomplete');
  const gitopsSha = String(gitopsRevision ?? '');
  if (!SHA.test(gitopsSha)) fail('GitOps revision must be a 40-character hex SHA');
  const binding = validateProvenance(provenance);
  for (const roleName of ROLES) {
    const declared = overlay.images[roleName];
    if (declared.tag !== binding.images[roleName].tag) {
      fail(roleName + ' deployed tag disagrees with build provenance');
    }
  }
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    fail('cluster observation must be an object');
  }
  const observedEnvironment = String(observation.environment_id ?? '');
  if (observedEnvironment !== overlay.environment_id) {
    fail('cluster observation environment does not match the trusted overlay');
  }
  if (observation.namespace !== overlay.namespace) {
    fail('cluster observation namespace does not match the trusted overlay');
  }
  const clusterContext = singleLine(observation.cluster_context, 'cluster context');
  const observedAt = singleLine(observation.observed_at, 'observation timestamp');
  if (!Number.isFinite(Date.parse(observedAt))) fail('observation timestamp is not ISO-8601');
  if (!Array.isArray(observation.workloads)) fail('cluster observation workloads must be an array');
  const workloads = new Map();
  for (const workload of observation.workloads) {
    if (!workload || typeof workload !== 'object') fail('cluster observation workload must be an object');
    const roleName = role(workload.role, 'cluster observation workload role');
    if (workloads.has(roleName)) fail('cluster observation contains duplicate ' + roleName + ' workload');
    if (workload.namespace !== overlay.namespace) {
      fail(roleName + ' workload namespace does not match the trusted overlay');
    }
    const name = singleLine(workload.name, roleName + ' workload name');
    if (name !== overlay.expected_workloads?.[roleName]) {
      fail(roleName + ' workload name does not match the trusted overlay');
    }
    if (overlay.env_label && workload.labels?.env !== overlay.env_label) {
      fail(roleName + ' workload env label does not match the trusted overlay');
    }
    if (workload.ready !== true) fail(roleName + ' workload is not ready');
    const generation = workload.generation;
    const observedGeneration = workload.observed_generation;
    if (!Number.isSafeInteger(generation) || generation < 1) fail(roleName + ' workload generation is invalid');
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < generation) {
      fail(roleName + ' workload observed generation is stale');
    }
    const declared = overlay.images[roleName];
    const expectedImage = declared.repository + ':' + declared.tag;
    if (workload.image !== expectedImage) fail(roleName + ' workload image tag does not match the trusted overlay');
    const expectedImageId = declared.repository + '@' + binding.images[roleName].digest;
    if (workload.image_id !== expectedImageId) {
      fail(roleName + ' workload imageID does not match the immutable provenance digest');
    }
    workloads.set(roleName, {
      role: roleName,
      name,
      namespace: overlay.namespace,
      uid: singleLine(workload.uid, roleName + ' workload UID'),
      generation,
      observed_generation: observedGeneration,
      ready: true,
      image: expectedImage,
      image_id: expectedImageId,
      digest: binding.images[roleName].digest,
    });
  }
  for (const roleName of ROLES) {
    if (!workloads.has(roleName)) fail('cluster observation is missing the ' + roleName + ' workload');
  }
  return {
    schema_version: 1,
    kind: 'nession_deployment_attestation',
    status: 'Attested',
    environment_id: overlay.environment_id,
    namespace: overlay.namespace,
    cluster_context: clusterContext,
    gitops_revision: gitopsSha,
    observed_at: new Date(Date.parse(observedAt)).toISOString(),
    source_sha: binding.source_sha,
    images: ROLES.map((roleName) => ({
      role: roleName,
      repository: overlay.images[roleName].repository,
      tag: overlay.images[roleName].tag,
      digest: binding.images[roleName].digest,
    })),
    workloads: ROLES.map((roleName) => workloads.get(roleName)),
  };
}

// Re-validate a stored attestation receipt without the original overlay,
// provenance or cluster JSON. This is the durable-store trust boundary: a
// receipt is only acceptable when its own fields still form one consistent
// source -> digest -> ready-workload chain.
export function validateAttestation(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('attestation receipt must be an object');
  }
  if (Number(receipt.schema_version) !== 1 || receipt.kind !== 'nession_deployment_attestation') {
    fail('unsupported deployment attestation schema');
  }
  if (receipt.status !== 'Attested') fail('deployment attestation is not Attested');
  const environmentId = String(receipt.environment_id ?? '');
  if (!ENVIRONMENT.test(environmentId)) fail('attestation environment id is invalid');
  const namespace = singleLine(receipt.namespace, 'attestation namespace');
  const clusterContext = singleLine(receipt.cluster_context, 'attestation cluster context');
  const gitopsRevision = String(receipt.gitops_revision ?? '');
  if (!SHA.test(gitopsRevision)) fail('attestation GitOps revision is invalid');
  const sourceSha = String(receipt.source_sha ?? '');
  if (!SHA.test(sourceSha)) fail('attestation source SHA is invalid');
  const observedAt = singleLine(receipt.observed_at, 'attestation observation timestamp');
  if (!Number.isFinite(Date.parse(observedAt))) fail('attestation observation timestamp is not ISO-8601');
  if (!Array.isArray(receipt.images)) fail('attestation images must be an array');
  if (!Array.isArray(receipt.workloads)) fail('attestation workloads must be an array');
  const images = new Map();
  for (const image of receipt.images) {
    const roleName = role(image?.role, 'attestation image role');
    if (images.has(roleName)) fail('attestation contains duplicate ' + roleName + ' image');
    const repository = singleLine(image.repository, roleName + ' attestation repository');
    if (!REPOSITORY.test(repository)) fail(roleName + ' attestation repository is invalid');
    const tag = singleLine(image.tag, roleName + ' attestation tag');
    if (!TAG.test(tag) || !tag.startsWith(roleName + '-')) fail(roleName + ' attestation tag is invalid');
    const digest = singleLine(image.digest, roleName + ' attestation digest');
    if (!DIGEST.test(digest)) fail(roleName + ' attestation digest is invalid');
    images.set(roleName, { repository, tag, digest });
  }
  for (const roleName of ROLES) {
    if (!images.has(roleName)) fail('attestation is missing the ' + roleName + ' image');
  }
  const workloads = new Map();
  for (const workload of receipt.workloads) {
    const roleName = role(workload?.role, 'attestation workload role');
    if (workloads.has(roleName)) fail('attestation contains duplicate ' + roleName + ' workload');
    if (workload.namespace !== namespace) fail(roleName + ' workload namespace disagrees with attestation');
    const name = singleLine(workload.name, roleName + ' workload name');
    const uid = singleLine(workload.uid, roleName + ' workload UID');
    const generation = workload.generation;
    const observedGeneration = workload.observed_generation;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      fail(roleName + ' workload generation is invalid');
    }
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < generation) {
      fail(roleName + ' workload observed generation is stale');
    }
    if (workload.ready !== true) fail(roleName + ' workload is not ready');
    const image = images.get(roleName);
    if (workload.image !== image.repository + ':' + image.tag) {
      fail(roleName + ' workload image disagrees with attestation image');
    }
    if (workload.image_id !== image.repository + '@' + image.digest) {
      fail(roleName + ' workload imageID disagrees with attestation digest');
    }
    if (workload.digest !== image.digest) {
      fail(roleName + ' workload digest disagrees with attestation image');
    }
    workloads.set(roleName, {
      role: roleName,
      name,
      namespace,
      uid,
      generation,
      observed_generation: observedGeneration,
      ready: true,
      image: workload.image,
      image_id: workload.image_id,
      digest: image.digest,
    });
  }
  for (const roleName of ROLES) {
    if (!workloads.has(roleName)) fail('attestation is missing the ' + roleName + ' workload');
  }
  return {
    schema_version: 1,
    kind: 'nession_deployment_attestation',
    status: 'Attested',
    environment_id: environmentId,
    namespace,
    cluster_context: clusterContext,
    gitops_revision: gitopsRevision,
    observed_at: new Date(Date.parse(observedAt)).toISOString(),
    source_sha: sourceSha,
    images: ROLES.map((roleName) => ({ role: roleName, ...images.get(roleName) })),
    workloads: ROLES.map((roleName) => workloads.get(roleName)),
  };
}

function overlayFixture({ environmentId = 'staging', namespace = 'nession', suffix = '-staging', tags } = {}) {  const path = 'environments/' + environmentId + '/nession/kustomization.yaml';
  const image = (roleName) => 'ghcr.io/bestnathan/nession-' + roleName;
  const tag = (roleName) => (tags ? tags[roleName] : roleName + '-abcdef1');
  return {
    path,
    text: [
      'apiVersion: kustomize.config.k8s.io/v1beta1',
      'kind: Kustomization',
      'namespace: ' + namespace,
      'nameSuffix: ' + suffix,
      'commonLabels:',
      '  env: ' + environmentId,
      'resources:',
      '- ../../../base/nession',
      'images:',
      '- name: ' + image('agent'),
      '  newName: ghcr.io/bestnathan/nession',
      '  newTag: ' + tag('agent'),
      '- name: ' + image('server'),
      '  newName: ghcr.io/bestnathan/nession',
      '  newTag: ' + tag('server'),
      '- name: ' + image('ui'),
      '  newName: ghcr.io/bestnathan/nession',
      '  newTag: ' + tag('ui'),
      'patchesStrategicMerge:',
      '- patch-imagepullsecrets.yaml',
    ].join('\n'),
  };
}

function provenanceFixture(sourceSha, tags) {
  return {
    schema_version: 1,
    kind: 'nession_build_provenance',
    source_sha: sourceSha,
    images: Object.fromEntries(ROLES.map((roleName, index) => [roleName, {
      tag: tags ? tags[roleName] : roleName + '-' + sourceSha.slice(0, 7),
      digest: 'sha256:' + String(index + 1).repeat(64),
    }])),
  };
}

function observationFixture(overlay, provenance, { environmentId = 'staging', mutate } = {}) {
  const observation = {
    environment_id: environmentId,
    namespace: overlay.namespace,
    cluster_context: 'home-k8s',
    observed_at: '2026-10-24T16:00:00Z',
    workloads: ROLES.map((roleName) => ({
      role: roleName,
      name: overlay.expected_workloads[roleName],
      namespace: overlay.namespace,
      uid: 'uid-' + roleName,
      generation: 7,
      observed_generation: 7,
      ready: true,
      image: overlay.images[roleName].repository + ':' + overlay.images[roleName].tag,
      image_id: overlay.images[roleName].repository + '@' + provenance.images[roleName].digest,
      labels: { env: environmentId },
    })),
  };
  if (mutate) mutate(observation);
  return observation;
}

function selfTest() {
  const sourceSha = 'abcdef1' + 'a'.repeat(33);
  const overlayFixtureObject = overlayFixture();
  const overlay = parseEnvironmentOverlay(overlayFixtureObject.path, overlayFixtureObject.text);
  assert.equal(overlay.environment_id, 'staging');
  assert.equal(overlay.namespace, 'nession');
  assert.equal(overlay.name_suffix, '-staging');
  assert.equal(overlay.env_label, 'staging');
  assert.deepEqual(overlay.expected_workloads, {
    agent: 'nession-agent-staging', server: 'nession-server-staging', ui: 'nession-ui-staging',
  });
  assert.equal(overlay.images.server.tag, 'server-abcdef1');

  const provenance = provenanceFixture(sourceSha);
  const observation = observationFixture(overlay, provenance);
  const receipt = attestDeployment({
    overlay, provenance, gitopsRevision: 'b'.repeat(40), observation,
  });
  assert.equal(receipt.status, 'Attested');
  assert.equal(receipt.source_sha, sourceSha);
  assert.equal(receipt.images.length, 3);
  assert.equal(receipt.workloads.length, 3);
  assert.equal(receipt.images.find((image) => image.role === 'server').digest,
    provenance.images.server.digest);

  // Durable-store validation must preserve the same binding without the
  // original overlay/provenance/cluster inputs.
  const validated = validateAttestation(receipt);
  assert.equal(validated.source_sha, sourceSha);
  assert.equal(validated.workloads[1].digest, provenance.images.server.digest);
  const badReceipt = (mutate, pattern) => {
    const copy = structuredClone(receipt);
    mutate(copy);
    assert.throws(() => validateAttestation(copy), pattern);
  };
  badReceipt((copy) => { copy.kind = 'other'; }, /unsupported deployment attestation schema/);
  badReceipt((copy) => { copy.status = 'Pending'; }, /not Attested/);
  badReceipt((copy) => { copy.environment_id = 'Bad_Env'; }, /environment id is invalid/);
  badReceipt((copy) => { copy.gitops_revision = 'x'.repeat(40); }, /GitOps revision/);
  badReceipt((copy) => { copy.source_sha = 'x'.repeat(40); }, /source SHA is invalid/);
  badReceipt((copy) => { copy.observed_at = 'not-a-time'; }, /ISO-8601/);
  badReceipt((copy) => { copy.images.pop(); }, /missing the ui image/);
  badReceipt((copy) => { copy.images.push({ ...copy.images[1] }); }, /duplicate server image/);
  badReceipt((copy) => { copy.images[1].digest = 'sha256:' + 'f'.repeat(64); },
    /workload imageID disagrees/);
  badReceipt((copy) => { copy.workloads.pop(); }, /missing the ui workload/);
  badReceipt((copy) => { copy.workloads[1].ready = false; }, /not ready/);
  badReceipt((copy) => { copy.workloads[1].observed_generation = 1; }, /stale/);
  badReceipt((copy) => { copy.workloads[1].namespace = 'nession-staging-01'; }, /namespace disagrees/);
  badReceipt((copy) => { copy.workloads[2].role = 'server'; }, /duplicate server workload/);

  // A version tag is valid only when trusted provenance binds it to a source SHA.
  const productionOverlay = parseEnvironmentOverlay(
    'environments/production/nession/kustomization.yaml',
    overlayFixture({ environmentId: 'production', namespace: 'nession', suffix: '', tags: {
      agent: 'agent-0.35.0', server: 'server-0.35.0', ui: 'ui-0.35.0',
    } }).text);
  const productionProvenance = provenanceFixture(sourceSha, {
    agent: 'agent-0.35.0', server: 'server-0.35.0', ui: 'ui-0.35.0',
  });
  const productionReceipt = attestDeployment({
    overlay: productionOverlay,
    provenance: productionProvenance,
    gitopsRevision: 'b'.repeat(40),
    observation: observationFixture(productionOverlay, productionProvenance, { environmentId: 'production' }),
  });
  assert.equal(productionReceipt.environment_id, 'production');

  const clone = (value) => structuredClone(value);
  const reject = (mutate, pattern) => {
    const nextOverlay = clone(overlay);
    const nextProvenance = clone(provenance);
    const nextObservation = clone(observation);
    mutate({ overlay: nextOverlay, provenance: nextProvenance, observation: nextObservation });
    assert.throws(() => attestDeployment({
      overlay: nextOverlay, provenance: nextProvenance,
      gitopsRevision: 'b'.repeat(40), observation: nextObservation,
    }), pattern);
  };

  assert.throws(() => resolveEnvironment('staging-02', ['staging', 'staging-01']), /not registered/);
  assert.throws(() => resolveEnvironment('staging', []), /inventory is required/);
  assert.equal(resolveEnvironment('staging-01', ['staging', 'staging-01']), 'staging-01');
  assert.throws(() => environmentOverlayPath('Staging_01'), /invalid/);
  assert.equal(environmentOverlayPath('staging-01'), 'environments/staging-01/nession/kustomization.yaml');
  assert.throws(() => parseEnvironmentOverlay('environments/staging/other.yaml', overlayFixtureObject.text),
    /not a trusted environment/);
  assert.throws(() => parseEnvironmentOverlay(overlayFixtureObject.path,
    overlayFixtureObject.text.replace('- name: ghcr.io/bestnathan/nession-ui\n  newName: ghcr.io/bestnathan/nession\n  newTag: ui-abcdef1\n', '')),
  /missing the ui image/);
  assert.throws(() => parseEnvironmentOverlay(overlayFixtureObject.path,
    overlayFixtureObject.text.replace('newTag: server-abcdef1', 'newTag: agent-abcdef1')),
  /not role-scoped/);

  reject(({ observation: next }) => { next.environment_id = 'staging-01'; }, /environment does not match/);
  reject(({ observation: next }) => { next.namespace = 'nession-staging-01'; }, /namespace does not match/);
  reject(({ observation: next }) => { next.cluster_context = ''; }, /cluster context/);
  reject(({ observation: next }) => { next.observed_at = 'not-a-time'; }, /ISO-8601/);
  reject(({ observation: next }) => { next.workloads.pop(); }, /missing the ui workload/);
  reject(({ observation: next }) => { next.workloads[1].name = 'nession-server'; }, /name does not match/);
  reject(({ observation: next }) => { next.workloads[1].namespace = 'nession-staging-01'; }, /namespace does not match/);
  reject(({ observation: next }) => { next.workloads[1].labels.env = 'staging-01'; }, /env label/);
  reject(({ observation: next }) => { next.workloads[1].ready = false; }, /not ready/);
  reject(({ observation: next }) => { next.workloads[1].observed_generation = 6; }, /stale/);
  reject(({ observation: next }) => { next.workloads[1].uid = ''; }, /UID/);
  reject(({ observation: next }) => { next.workloads[1].image = next.workloads[1].image.replace('abcdef1', 'abcdef2'); },
    /image tag does not match/);
  reject(({ observation: next }) => { next.workloads[1].image_id = 'ghcr.io/bestnathan/nession@sha256:' + 'f'.repeat(64); },
    /imageID does not match/);
  reject(({ observation: next }) => { next.workloads[2].role = 'server'; }, /duplicate server workload/);
  reject(({ provenance: next }) => { next.source_sha = 'a'.repeat(39); }, /40-character hex SHA/);
  reject(({ provenance: next }) => { delete next.images.ui; }, /missing the ui image/);
  reject(({ provenance: next }) => { next.images.ui.digest = 'sha256:short'; }, /immutable sha256 digest/);
  reject(({ provenance: next }) => { next.images.ui.tag = 'ui-deadbee'; }, /does not match the provenance source SHA/);
  reject(({ overlay: next }) => { next.images.ui.tag = 'ui-abcdef2'; }, /disagrees with build provenance/);
  reject(({ provenance: next }) => { next.kind = 'unknown'; }, /unsupported build provenance schema/);

  assert.throws(() => attestDeployment({
    overlay, provenance, gitopsRevision: 'not-a-sha', observation,
  }), /GitOps revision/);

  console.log('deployment-identity-policy: overlay, provenance and observed-workload scenarios passed');
}

if (process.argv[1]?.endsWith('deployment-identity-policy.mjs')) {
  if (process.argv[2] !== 'self-test') {
    console.error('usage: deployment-identity-policy.mjs self-test');
    process.exitCode = 2;
  } else {
    selfTest();
  }
}
