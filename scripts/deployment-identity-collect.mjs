#!/usr/bin/env node
// Owner: #1616 (deployment identity) consumed by #2323 lane acceptance and
// Staging Full scheduling. This adapter turns trusted read-only Kubernetes
// observations plus trusted build provenance into the canonical attestation
// owned by scripts/deployment-identity-policy.mjs.
//
// It never talks to a cluster, registry or GitHub itself. A trusted workflow
// must supply exact-SHA provenance from the trusted build run and raw
// `kubectl get deployments/pods -o json` output from the environment it
// intends to attest. Any ambiguity fails closed.
import fs from 'node:fs';
import assert from 'node:assert/strict';

import {
  ROLES,
  attestDeployment,
  parseEnvironmentOverlay,
} from './deployment-identity-policy.mjs';

function fail(message) {
  throw new Error(message);
}

function nonEmptyLine(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /[\r\n]/.test(text)) fail(label + ' must be a non-empty single line');
  return text;
}

function list(items, label) {
  if (!Array.isArray(items)) fail(label + ' must be an array');
  return items;
}

function workloadImage(container, overlay, roleName) {
  const tag = overlay.images[roleName].tag;
  const repository = overlay.images[roleName].repository;
  const expected = repository + ':' + tag;
  if (container?.image !== expected) {
    fail(roleName + ' deployment image does not match the trusted overlay tag');
  }
  return expected;
}

function deploymentFor(overlay, roleName, deployments) {
  const expectedName = overlay.expected_workloads[roleName];
  const matches = deployments.filter((deployment) => deployment?.metadata?.name === expectedName);
  if (matches.length === 0) fail('missing ' + roleName + ' deployment ' + expectedName);
  if (matches.length > 1) fail('duplicate ' + roleName + ' deployment ' + expectedName);
  const deployment = matches[0];
  if (deployment.metadata.namespace !== overlay.namespace) {
    fail(roleName + ' deployment namespace does not match the trusted overlay');
  }
  const containers = list(deployment.spec?.template?.spec?.containers, roleName + ' deployment containers');
  const roleContainers = containers.filter((container) => {
    const expected = overlay.images[roleName].repository + ':';
    return String(container?.image ?? '').startsWith(expected);
  });
  if (roleContainers.length !== 1) {
    fail(roleName + ' deployment must have exactly one role container');
  }
  const image = workloadImage(roleContainers[0], overlay, roleName);
  const generation = deployment.metadata?.generation;
  const observedGeneration = deployment.status?.observedGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1) fail(roleName + ' deployment generation is invalid');
  if (!Number.isSafeInteger(observedGeneration) || observedGeneration < generation) {
    fail(roleName + ' deployment observed generation is stale');
  }
  const available = (deployment.status?.conditions ?? [])
    .find((condition) => condition?.type === 'Available');
  if (available?.status !== 'True') fail(roleName + ' deployment is not Available');
  if (!Number.isSafeInteger(deployment.status?.availableReplicas) || deployment.status.availableReplicas < 1) {
    fail(roleName + ' deployment has no available replica');
  }
  return {
    deployment,
    image,
    generation,
    observedGeneration,
    uid: nonEmptyLine(deployment.metadata?.uid, roleName + ' deployment UID'),
  };
}

function imageIdFor(overlay, roleName, deploymentName, image, pods) {
  // A cluster registry mirror may resolve the deployment image to another
  // repository, so the pod status image string can differ from the GitOps
  // image while keeping the same immutable role tag. Match the role tag and
  // let the attestation bind the digest to trusted per-registry provenance.
  const tagSuffix = ':' + image.slice(image.lastIndexOf(':') + 1);
  const matchesTag = (entry) =>
    typeof entry?.image === 'string' && entry.image.endsWith(tagSuffix);
  // A deployment's ReplicaSet is `<deployment-name>-<pod-template-hash>`, and
  // the hash never contains a dash. Matching by plain prefix adopted a sibling
  // lane whose name extends this one (nession-agent-staging vs
  // nession-agent-staging-01), and the sibling's env label then rejected this
  // lane's attestation (#2523).
  const escapedName = deploymentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replicaSetName = new RegExp('^' + escapedName + '-[^-]+$');
  const matching = pods.filter((pod) => {
    const owner = pod?.metadata?.ownerReferences?.[0];
    return owner?.kind === 'ReplicaSet' &&
      typeof owner.name === 'string' && replicaSetName.test(owner.name);
  });
  if (matching.length === 0) fail('missing running pod for ' + roleName + ' deployment');
  const imageIds = new Set();
  for (const pod of matching) {
    if (pod.metadata?.namespace !== overlay.namespace) {
      fail(roleName + ' pod namespace does not match the trusted overlay');
    }
    if (overlay.env_label && pod.metadata?.labels?.env !== overlay.env_label) {
      fail(roleName + ' pod env label does not match the trusted overlay');
    }
    if (pod.status?.phase !== 'Running') fail(roleName + ' pod is not Running');
    const statuses = list(pod.status?.containerStatuses, roleName + ' pod container statuses');
    const status = statuses.find((entry) => matchesTag(entry) && entry?.ready === true);
    if (!status && statuses.some(matchesTag)) {
      fail(roleName + ' pod container is not ready');
    }
    if (!status) continue;
    const imageId = nonEmptyLine(status.imageID, roleName + ' pod imageID');
    imageIds.add(imageId);
  }
  if (imageIds.size === 0) fail('no ready pod reports the ' + roleName + ' deployment image');
  // A rollout can leave old and new pods side by side. Two different immutable
  // identities mean the environment is mid-change and must not be attested.
  if (imageIds.size > 1) fail(roleName + ' pods disagree on the running imageID');
  return [...imageIds][0];
}

// Map raw `kubectl get deployments` / `kubectl get pods` JSON to the policy's
// observation shape. Every field is derived from the exact deployment/pod the
// trusted overlay names; no caller-supplied workload identity is trusted.
export function observationFromKubernetes({
  overlay, environmentId, clusterContext, observedAt, deployments, pods,
}) {
  if (environmentId !== overlay.environment_id) {
    fail('observation environment does not match the trusted overlay');
  }
  const deploymentItems = list(deployments?.items, 'deployment items');
  const podItems = list(pods?.items, 'pod items');
  const workloads = ROLES.map((roleName) => {
    const selected = deploymentFor(overlay, roleName, deploymentItems);
    const imageId = imageIdFor(
      overlay, roleName, selected.deployment.metadata.name, selected.image, podItems);
    return {
      role: roleName,
      name: selected.deployment.metadata.name,
      namespace: overlay.namespace,
      uid: selected.uid,
      generation: selected.generation,
      observed_generation: selected.observedGeneration,
      ready: true,
      image: selected.image,
      image_id: imageId,
      labels: { env: overlay.env_label },
    };
  });
  return {
    environment_id: overlay.environment_id,
    namespace: overlay.namespace,
    cluster_context: nonEmptyLine(clusterContext, 'cluster context'),
    observed_at: nonEmptyLine(observedAt, 'observation timestamp'),
    workloads,
  };
}

export function attestFromObservations({
  overlayPath, overlayText, gitopsRevision, provenance, environmentId,
  clusterContext, observedAt, deployments, pods,
}) {
  const overlay = parseEnvironmentOverlay(overlayPath, overlayText);
  const observation = observationFromKubernetes({
    overlay, environmentId, clusterContext, observedAt, deployments, pods,
  });
  return attestDeployment({ overlay, provenance, gitopsRevision, observation });
}

function readJson(path, label) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    fail(label + ' is unreadable: ' + error.message);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(label + ' is not valid JSON');
  }
}

function arg(args, name) {
  const index = args.indexOf('--' + name);
  if (index < 0 || index === args.length - 1) fail('missing --' + name);
  return args[index + 1];
}

function main(args) {
  if (args[0] === 'self-test') {
    selfTest();
    return;
  }
  if (args[0] !== 'attest') fail('usage: attest --overlay-path ... --overlay ... --gitops-revision ... --provenance ... --deployments ... --pods ... --cluster-context ... --observed-at ... [--out ...]');
  const receipt = attestFromObservations({
    overlayPath: arg(args, 'overlay-path'),
    overlayText: fs.readFileSync(arg(args, 'overlay'), 'utf8'),
    gitopsRevision: arg(args, 'gitops-revision'),
    provenance: readJson(arg(args, 'provenance'), 'provenance'),
    environmentId: arg(args, 'environment'),
    clusterContext: arg(args, 'cluster-context'),
    observedAt: arg(args, 'observed-at'),
    deployments: readJson(arg(args, 'deployments'), 'deployments'),
    pods: readJson(arg(args, 'pods'), 'pods'),
  });
  const json = JSON.stringify(receipt, null, 2) + '\n';
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], json);
  process.stdout.write(json);
}

const OVERLAY_TEXT = [
  'apiVersion: kustomize.config.k8s.io/v1beta1',
  'kind: Kustomization',
  'namespace: nession',
  'nameSuffix: -staging',
  'commonLabels:',
  '  env: staging',
  'images:',
  '- name: ghcr.io/bestnathan/nession-agent',
  '  newName: ghcr.io/bestnathan/nession',
  '  newTag: agent-abcdef1',
  '- name: ghcr.io/bestnathan/nession-server',
  '  newName: ghcr.io/bestnathan/nession',
  '  newTag: server-abcdef1',
  '- name: ghcr.io/bestnathan/nession-ui',
  '  newName: ghcr.io/bestnathan/nession',
  '  newTag: ui-abcdef1',
].join('\n');
const OVERLAY_PATH = 'environments/staging/nession/kustomization.yaml';
const SOURCE_SHA = 'abcdef1' + 'a'.repeat(33);
const DIGESTS = { agent: '1', server: '2', ui: '3' };

function provenanceFixture() {
  return {
    schema_version: 1,
    kind: 'nession_build_provenance',
    source_sha: SOURCE_SHA,
    images: Object.fromEntries(ROLES.map((roleName) => [roleName, {
      tag: roleName + '-abcdef1', digest: 'sha256:' + DIGESTS[roleName].repeat(64),
    }])),
  };
}

function kubernetesFixtures({ mutateDeployments, mutatePods } = {}) {
  const deployments = {
    items: ROLES.map((roleName) => ({
      metadata: {
        name: 'nession-' + roleName + '-staging',
        namespace: 'nession',
        uid: 'uid-' + roleName,
        generation: 9,
        labels: { app: 'nession', env: 'staging' },
      },
      spec: { template: { spec: { containers: [{
        name: roleName,
        image: 'ghcr.io/bestnathan/nession:' + roleName + '-abcdef1',
      }] } } },
      status: {
        observedGeneration: 9,
        replicas: 1,
        availableReplicas: 1,
        conditions: [{ type: 'Available', status: 'True' }],
      },
    })),
  };
  const pods = {
    items: ROLES.map((roleName) => ({
      metadata: {
        name: 'nession-' + roleName + '-staging-abc12',
        namespace: 'nession',
        labels: { app: 'nession', env: 'staging' },
        ownerReferences: [{ kind: 'ReplicaSet', name: 'nession-' + roleName + '-staging-abc12' }],
      },
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: roleName,
          image: 'ghcr.io/bestnathan/nession:' + roleName + '-abcdef1',
          imageID: 'ghcr.io/bestnathan/nession@sha256:' + DIGESTS[roleName].repeat(64),
          ready: true,
        }],
      },
    })),
  };
  if (mutateDeployments) mutateDeployments(deployments);
  if (mutatePods) mutatePods(pods);
  return { deployments, pods };
}

function selfTest() {
  const base = {
    overlayPath: OVERLAY_PATH,
    overlayText: OVERLAY_TEXT,
    gitopsRevision: 'b'.repeat(40),
    provenance: provenanceFixture(),
    environmentId: 'staging',
    clusterContext: 'home-k8s',
    observedAt: '2026-10-24T16:00:00Z',
  };
  const positive = attestFromObservations({ ...base, ...kubernetesFixtures() });
  assert.equal(positive.source_sha, SOURCE_SHA);
  assert.equal(positive.workloads.length, 3);
  assert.equal(positive.workloads[0].image_id,
    'ghcr.io/bestnathan/nession@sha256:' + '1'.repeat(64));

  // A registry mirror may rewrite the pod status image reference while the
  // immutable role tag stays the same. The observer matches the tag suffix;
  // attestation still binds the digest to trusted provenance.
  const mirrorFixtures = kubernetesFixtures();
  for (const pod of mirrorFixtures.pods.items) {
    const roleName = pod.metadata.name.split('-')[1];
    pod.status.containerStatuses[0].image =
      'mirror.example.com/nession:' + roleName + '-abcdef1';
  }
  const mirrorObservation = observationFromKubernetes({
    overlay: parseEnvironmentOverlay(OVERLAY_PATH, OVERLAY_TEXT),
    environmentId: 'staging',
    clusterContext: 'home-k8s',
    observedAt: '2026-10-24T16:00:00Z',
    deployments: mirrorFixtures.deployments,
    pods: mirrorFixtures.pods,
  });
  assert.equal(mirrorObservation.workloads.length, 3);
  const wrongTagFixtures = kubernetesFixtures();
  wrongTagFixtures.pods.items[0].status.containerStatuses[0].image =
    'mirror.example.com/nession:agent-0000000';
  assert.throws(() => observationFromKubernetes({
    overlay: parseEnvironmentOverlay(OVERLAY_PATH, OVERLAY_TEXT),
    environmentId: 'staging',
    clusterContext: 'home-k8s',
    observedAt: '2026-10-24T16:00:00Z',
    deployments: wrongTagFixtures.deployments,
    pods: wrongTagFixtures.pods,
  }), /no ready pod reports the agent deployment image/);

  // #2523: lanes share one namespace, so a sibling whose name extends this
  // deployment (nession-agent-staging vs nession-agent-staging-01) has pods in
  // the same list. They must never be adopted by the shorter lane; the old
  // startsWith match did exactly that and then failed on the env label.
  const siblingFixtures = kubernetesFixtures();
  for (const roleName of ROLES) {
    const sibling = structuredClone(
      siblingFixtures.pods.items.find((pod) => pod.metadata.name.includes('-' + roleName + '-')));
    sibling.metadata.name = 'nession-' + roleName + '-staging-01-zz999';
    sibling.metadata.labels.env = 'staging-01';
    sibling.metadata.ownerReferences[0].name = 'nession-' + roleName + '-staging-01-zz999';
    siblingFixtures.pods.items.push(sibling);
  }
  const siblingObservation = observationFromKubernetes({
    overlay: parseEnvironmentOverlay(OVERLAY_PATH, OVERLAY_TEXT),
    environmentId: 'staging',
    clusterContext: 'home-k8s',
    observedAt: '2026-10-24T16:00:00Z',
    deployments: siblingFixtures.deployments,
    pods: siblingFixtures.pods,
  });
  assert.equal(siblingObservation.workloads.length, 3);
  const onlySibling = kubernetesFixtures();
  onlySibling.pods.items = siblingFixtures.pods.items.filter(
    (pod) => pod.metadata.labels.env === 'staging-01');
  assert.throws(() => observationFromKubernetes({
    overlay: parseEnvironmentOverlay(OVERLAY_PATH, OVERLAY_TEXT),
    environmentId: 'staging',
    clusterContext: 'home-k8s',
    observedAt: '2026-10-24T16:00:00Z',
    deployments: onlySibling.deployments,
    pods: onlySibling.pods,
  }), /missing running pod for agent/);

  const reject = (mutations, pattern) => {
    const fixtures = kubernetesFixtures(mutations);
    try {
      attestFromObservations({ ...base, ...fixtures });
    } catch (error) {
      if (pattern.test(error.message)) return;
      throw new Error('unexpected rejection ' + pattern + ': ' + error.message);
    }
    throw new Error('missing rejection ' + pattern);
  };
  assert.throws(() => attestFromObservations({ ...base, ...kubernetesFixtures(), environmentId: 'staging-01' }),
    /environment does not match/);
  assert.throws(() => attestFromObservations({ ...base, ...kubernetesFixtures(), observedAt: '' }),
    /observation timestamp/);
  reject({ mutateDeployments: (d) => { d.items.pop(); } }, /missing ui deployment/);
  reject({ mutateDeployments: (d) => { d.items.push(structuredClone(d.items[1])); } },
    /duplicate server deployment/);
  reject({ mutateDeployments: (d) => { d.items[1].metadata.namespace = 'nession-staging-01'; } },
    /namespace does not match/);
  reject({ mutateDeployments: (d) => { d.items[1].status.observedGeneration = 8; } },
    /observed generation is stale/);
  reject({ mutateDeployments: (d) => { d.items[1].status.conditions[0].status = 'False'; } },
    /not Available/);
  reject({ mutateDeployments: (d) => { d.items[1].status.availableReplicas = 0; } },
    /no available replica/);
  reject({ mutateDeployments: (d) => {
    d.items[1].spec.template.spec.containers.push({
      name: 'duplicate', image: 'ghcr.io/bestnathan/nession:server-abcdef1',
    });
  } }, /exactly one role container/);
  reject({ mutateDeployments: (d) => {
    d.items[1].spec.template.spec.containers[0].image = 'ghcr.io/bestnathan/nession:server-abcdef2';
  } }, /image does not match/);
  reject({ mutatePods: (p) => { p.items.pop(); } }, /missing running pod for ui/);
  reject({ mutatePods: (p) => { p.items[1].status.phase = 'Pending'; } }, /not Running/);
  reject({ mutatePods: (p) => { p.items[1].status.containerStatuses[0].ready = false; } },
    /container is not ready/);
  reject({ mutatePods: (p) => { p.items[1].metadata.labels.env = 'staging-01'; } },
    /env label does not match/);
  reject({ mutatePods: (p) => {
    p.items[1].status.containerStatuses[0].imageID = 'ghcr.io/bestnathan/nession@sha256:' + 'f'.repeat(64);
  } }, /pods disagree|imageID does not match/);
  reject({ mutatePods: (p) => {
    p.items.push(structuredClone(p.items[1]));
    p.items[3].metadata.name = 'nession-server-staging-def34';
    p.items[3].metadata.ownerReferences[0].name = 'nession-server-staging-def34';
    p.items[3].status.containerStatuses[0].imageID = 'ghcr.io/bestnathan/nession@sha256:' + 'f'.repeat(64);
  } }, /pods disagree on the running imageID/);

  console.log('deployment-identity-collect: Kubernetes observation mapping scenarios passed');
}

if (process.argv[1]?.endsWith('deployment-identity-collect.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error('deployment-identity-collect: ' + error.message);
    process.exitCode = 2;
  }
}
