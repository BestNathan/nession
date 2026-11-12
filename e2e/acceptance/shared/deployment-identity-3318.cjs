'use strict';
// #3318 fixture driver: runs the canonical deployment identity collector as a
// real child process against deterministic Kubernetes/provenance inputs, so a
// Case can assert its exit class, its bounded rejection receipt and the
// absence of any attestation on failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const ROLES = ['agent', 'server', 'ui'];
const OVERLAY_PATH = 'environments/staging/nession/kustomization.yaml';
const SOURCE_SHA = 'abcdef1' + 'a'.repeat(33);
const REJECTION_PREFIX = 'DEPLOYMENT_IDENTITY_REJECTION_V1 ';
const ATTESTATION_PREFIX = 'DEPLOYMENT_ATTESTATION_V1 ';

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

function provenanceFixture() {
  return {
    schema_version: 1,
    kind: 'nession_build_provenance',
    source_sha: SOURCE_SHA,
    images: Object.fromEntries(ROLES.map((role) => [role, {
      tag: role + '-abcdef1', digest: 'sha256:' + (ROLES.indexOf(role) + 1).toString().repeat(64),
    }])),
  };
}

function kubernetesFixtures() {
  return {
    deployments: {
      items: ROLES.map((role) => ({
        metadata: {
          name: 'nession-' + role + '-staging',
          namespace: 'nession',
          uid: 'uid-' + role,
          generation: 9,
          labels: { app: 'nession', env: 'staging' },
        },
        spec: { template: { spec: { containers: [{
          name: role,
          image: 'ghcr.io/bestnathan/nession:' + role + '-abcdef1',
        }] } } },
        status: {
          observedGeneration: 9,
          replicas: 1,
          availableReplicas: 1,
          conditions: [{ type: 'Available', status: 'True' }],
        },
      })),
    },
    pods: {
      items: ROLES.map((role) => ({
        metadata: {
          name: 'nession-' + role + '-staging-abc12',
          namespace: 'nession',
          labels: { app: 'nession', env: 'staging' },
          ownerReferences: [{ kind: 'ReplicaSet', name: 'nession-' + role + '-staging-abc12' }],
        },
        status: {
          phase: 'Running',
          containerStatuses: [{
            name: role,
            image: 'ghcr.io/bestnathan/nession:' + role + '-abcdef1',
            imageID: 'ghcr.io/bestnathan/nession@sha256:' +
              (ROLES.indexOf(role) + 1).toString().repeat(64),
            ready: true,
          }],
        },
      })),
    },
  };
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

/**
 * Run `scripts/deployment-identity-collect.mjs attest` with deterministic
 * fixtures. `mutate` may change provenance/deployments/pods before the run.
 * Returns the process result plus the collector's only admissible rejection.
 */
function runCollector(mutate = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3318-'));
  try {
    const provenance = provenanceFixture();
    const fixtures = kubernetesFixtures();
    if (mutate.provenance) mutate.provenance(provenance);
    if (mutate.deployments) mutate.deployments(fixtures.deployments);
    if (mutate.pods) mutate.pods(fixtures.pods);
    const overlay = path.join(dir, 'overlay.yaml');
    fs.writeFileSync(overlay, OVERLAY_TEXT);
    const out = path.join(dir, 'attestation.json');
    const result = spawnSync(process.execPath, [
      'scripts/deployment-identity-collect.mjs', 'attest',
      '--overlay-path', OVERLAY_PATH,
      '--overlay', overlay,
      '--gitops-revision', 'b'.repeat(40),
      '--provenance', writeJson(dir, 'provenance.json', provenance),
      '--environment', 'staging',
      '--cluster-context', 'case-fixture',
      '--observed-at', '2026-11-12T00:00:00Z',
      '--deployments', writeJson(dir, 'deployments.json', fixtures.deployments),
      '--pods', writeJson(dir, 'pods.json', fixtures.pods),
      '--out', out,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    if (result.error) throw result.error;
    const rejected = String(result.stderr || '').split('\n')
      .filter((line) => line.startsWith(REJECTION_PREFIX));
    if (rejected.length > 1) throw new Error('expected at most one rejection receipt, found ' + rejected.length);
    return {
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      rejection: rejected.length === 1
        ? JSON.parse(rejected[0].slice(REJECTION_PREFIX.length))
        : null,
      outExists: fs.existsSync(out),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  root,
  ROLES,
  SOURCE_SHA,
  REJECTION_PREFIX,
  ATTESTATION_PREFIX,
  runCollector,
};
