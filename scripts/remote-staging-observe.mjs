#!/usr/bin/env node
// #1616: read-only, observation-only Staging profile on the EXISTING GOST
// connection. This trusted-main script is run only by Deploy / Identity.
// Never execute PR/case scripts with KUBECONFIG or relay credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { attestFromObservations } from './deployment-identity-collect.mjs';
import {
  ROLES, validateAttestation, validateRemoteStagingObservation,
} from './deployment-identity-policy.mjs';

function fail(message) { throw new Error(message); }

function required(args, key) {
  const index = args.indexOf('--' + key);
  if (index < 0 || index >= args.length - 1 || args[index + 1].startsWith('--')) {
    fail('missing --' + key);
  }
  return args[index + 1];
}

function jsonFile(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(label + ' is unavailable or invalid JSON'); }
}

function kubectlJSON(namespace, kind) {
  // Fixed argv, fixed resources, bounded runtime and JSON. No shell,
  // arbitrary URL, port-forward, exec, mutation or user-selected command.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace) ||
      !['deployments', 'pods'].includes(kind)) {
    fail('untrusted Kubernetes read selector');
  }
  try {
    return JSON.parse(execFileSync('kubectl',
      ['--request-timeout=20s', '-n', namespace, 'get', kind, '-o', 'json'], {
        encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  } catch {
    // Never log raw kubectl stdout/stderr, which may expose private topology.
    fail('bounded read-only Kubernetes snapshot failed (' + kind + ')');
  }
}

export function boundedSample(attestation, observed, at, offsetMs) {
  const baseline = validateAttestation(attestation);
  const live = validateAttestation(observed);
  for (const key of ['environment_id', 'source_sha', 'gitops_revision', 'namespace', 'cluster_context']) {
    if (baseline[key] !== live[key]) fail('remote-staging sample deployment identity drift: ' + key);
  }
  for (const role of ROLES) {
    const expected = baseline.workloads.find((w) => w.role === role);
    const actual = live.workloads.find((w) => w.role === role);
    if (!actual || !expected || actual.uid !== expected.uid ||
        actual.generation !== expected.generation ||
        actual.observed_generation !== expected.observed_generation ||
        actual.image_id !== expected.image_id || actual.ready !== true) {
      fail('remote-staging sample no longer matches ready attested workload: ' + role);
    }
  }
  return {
    at, offset_ms: offsetMs,
    workloads: ROLES.map((role) => {
      const w = live.workloads.find((entry) => entry.role === role);
      return { role, uid: w.uid, generation: w.generation,
        observed_generation: w.observed_generation, digest: w.digest, ready: true };
    }),
  };
}

export async function collectRemoteStaging({
  attestation, overlayPath, overlayText, gitopsRevision, provenance,
  read = kubectlJSON, wait = sleep, clock = () => new Date().toISOString(),
  monotonic = () => performance.now(),
}) {
  const initial = validateAttestation(attestation);
  if (!['staging', 'staging-01'].includes(initial.environment_id) ||
      initial.remote_observation || !process.env.KUBECONFIG) {
    fail('remote-staging requires a fresh attested Staging identity and CI kubeconfig');
  }
  const began = monotonic();
  const samples = [];
  for (let index = 0; index < 2; index++) {
    if (index) await wait(600);
    const deployments = await read(initial.namespace, 'deployments');
    const pods = await read(initial.namespace, 'pods');
    const timestamp = clock();
    const live = attestFromObservations({
      overlayPath, overlayText, gitopsRevision, provenance,
      environmentId: initial.environment_id,
      clusterContext: initial.cluster_context, observedAt: timestamp,
      deployments, pods,
    });
    samples.push(boundedSample(initial, live, timestamp,
      Math.max(0, Math.round(monotonic() - began))));
  }
  const remote = validateRemoteStagingObservation({
    schema_version: 1, kind: 'nession_remote_staging_observation',
    profile: 'remote-staging', status: 'Observed', evaluation: null,
    environment_id: initial.environment_id, source_sha: initial.source_sha,
    gitops_revision: initial.gitops_revision,
    attestation_observed_at: initial.observed_at, samples,
  }, initial);
  return validateAttestation({ ...initial, remote_observation: remote });
}

function testFixture() {
  const source = 'a'.repeat(40);
  const repository = 'ghcr.io/bestnathan/nession';
  const images = ROLES.map((role, i) => ({
    role, repository, declared_repository: repository, tag: role + '-' + source.slice(0, 7),
    digest: 'sha256:' + String(i + 1).repeat(64),
  }));
  return validateAttestation({
    schema_version: 1, kind: 'nession_deployment_attestation', status: 'Attested',
    environment_id: 'staging', namespace: 'nession', cluster_context: 'ci',
    gitops_revision: 'b'.repeat(40), observed_at: '2026-11-09T02:00:00.000Z',
    source_sha: source, images,
    workloads: images.map((img) => ({
      role: img.role, name: 'nession-' + img.role + '-staging', namespace: 'nession',
      uid: 'uid-' + img.role, generation: 2, observed_generation: 2, ready: true,
      image: repository + ':' + img.tag, image_id: repository + '@' + img.digest,
      digest: img.digest,
    })),
  });
}

function selfTest() {
  const initial = testFixture();
  const make = (at, offset_ms) => boundedSample(initial, initial, at, offset_ms);
  const raw = {
    schema_version: 1, kind: 'nession_remote_staging_observation',
    profile: 'remote-staging', status: 'Observed', evaluation: null,
    environment_id: initial.environment_id, source_sha: initial.source_sha,
    gitops_revision: initial.gitops_revision,
    attestation_observed_at: initial.observed_at,
    samples: [
      make('2026-11-09T02:00:01.000Z', 100),
      make('2026-11-09T02:00:02.000Z', 1100),
    ],
  };
  const accepted = validateAttestation({ ...initial, remote_observation: raw });
  assert.equal(accepted.remote_observation.profile, 'remote-staging');
  assert.equal(accepted.remote_observation.evaluation, null);
  assert.equal(accepted.remote_observation.samples.length, 2);
  assert.ok(!JSON.stringify(accepted).includes('DO_NOT_LEAK'));
  const reject = (patch) => assert.throws(
    () => validateAttestation({ ...initial, remote_observation: { ...raw, ...patch } }),
  );
  reject({ source_sha: 'c'.repeat(40) });
  reject({ environment_id: 'production' });
  reject({ profile: 'remote-production' });
  reject({ evaluation: 'Pass' });
  reject({ token: 'DO_NOT_LEAK' });
  reject({ samples: raw.samples.slice(0, 1) });
  reject({ samples: [raw.samples[0], { ...raw.samples[1], offset_ms: 100 }] });
  reject({ samples: [raw.samples[0], { ...raw.samples[1], at: '2026-11-09T02:20:02.000Z' }] });
  reject({ samples: [raw.samples[0], {
    ...raw.samples[1], workloads: raw.samples[1].workloads.map((w, i) =>
      i === 0 ? { ...w, digest: 'sha256:' + '9'.repeat(64) } : w),
  }] });
  assert.throws(() => boundedSample(initial, {
    ...initial, source_sha: 'c'.repeat(40),
  }, '2026-11-09T02:00:01.000Z', 100), /identity drift/);
  assert.throws(() => boundedSample(initial, {
    ...initial, workloads: initial.workloads.map((w, i) =>
      i === 0 ? { ...w, uid: 'different-pod' } : w),
  }, '2026-11-09T02:00:01.000Z', 100), /no longer matches/);
  assert.equal(validateAttestation(initial).remote_observation, undefined,
    'legacy deployment attestations must remain readable');
  console.log('remote-staging observation: bound UTC/monotonic/UID/digest, zero verdict, redaction and drift negatives passed');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'self-test') return selfTest();
  if (args[0] !== 'run' || required(args, 'profile') !== 'remote-staging') {
    fail('usage: run --profile remote-staging --attestation FILE --overlay-path PATH --overlay FILE --gitops-revision SHA --provenance FILE --out FILE');
  }
  const attestationFile = required(args, 'attestation');
  const out = required(args, 'out');
  if (!path.isAbsolute(attestationFile) || out !== attestationFile) {
    fail('collector can only replace its own absolute attestation file');
  }
  const final = await collectRemoteStaging({
    attestation: jsonFile(attestationFile, 'attestation'),
    overlayPath: required(args, 'overlay-path'),
    overlayText: fs.readFileSync(required(args, 'overlay'), 'utf8'),
    gitopsRevision: required(args, 'gitops-revision'),
    provenance: jsonFile(required(args, 'provenance'), 'provenance'),
  });
  // Only the canonical, allowlisted projection reaches persistent storage.
  const temp = out + '.remote.tmp';
  fs.writeFileSync(temp, JSON.stringify(final, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, out);
  console.log('REMOTE_STAGING_OBSERVED_V1 environment=' + final.environment_id +
    ' source=' + final.source_sha + ' samples=2 evaluation=null');
}

main().catch((error) => {
  console.error('Remote staging observation Error: ' +
    (error instanceof Error ? error.message : 'unknown error'));
  process.exitCode = 1;
});
