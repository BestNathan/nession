#!/usr/bin/env node
// Owner: #1616/#2323. Trusted ingestion of Deploy / Identity receipts into the
// single append-only `acceptance-results` store. This is a main-owned write
// boundary: the source workflow is read-only, and only this ingester may
// persist an attestation. Never trust a receipt's self-asserted verdict alone.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { validateAttestation } from './deployment-identity-policy.mjs';
import { validateRunIndex } from './run-record-index-contract.mjs';

export const REPOSITORY = 'BestNathan/nession';
export const WORKFLOW_NAME = 'Deploy / Identity';
export const WORKFLOW_PATH = '.github/workflows/deploy-identity.yml';
export const ARTIFACT_PREFIX = 'nession-deployment-attestation-';
const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;

function fail(message) {
  throw new Error(message);
}

function singleLine(value, label) {
  const text = String(value ?? '').trim();
  if (!text || /[\r\n]/.test(text)) fail(label + ' must be a non-empty single line');
  return text;
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(label + ' must be a positive integer');
  return number;
}

function sha(value, label) {
  const text = String(value ?? '');
  if (!SHA.test(text)) fail(label + ' must be a 40-character hex SHA');
  return text;
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Bind the artifact and receipt to GitHub's own workflow_run identity. The
// source workflow only observes; this ingester alone can write the store.
export function sourceRunIdentity(event, repository = REPOSITORY) {
  const run = event?.workflow_run;
  if (!run || run.name !== WORKFLOW_NAME) {
    throw new Error('expected a completed ' + WORKFLOW_NAME + ' workflow_run event');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('source deployment identity run has no successful terminal conclusion');
  }
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    throw new Error('source workflow repository mismatch');
  }
  const branch = singleLine(run.head_branch, 'workflow_run.head_branch');
  if (branch !== 'main') throw new Error('deployment identity must be attested from trusted main');
  const definition = singleLine(run.path, 'workflow_run.path');
  const [workflowPath, workflowRef, ...extra] = definition.split('@');
  if (extra.length ||
      ![WORKFLOW_PATH, repository + '/' + WORKFLOW_PATH].includes(workflowPath) ||
      (workflowRef && workflowRef !== 'refs/heads/' + branch)) {
    throw new Error('unexpected source workflow definition path');
  }
  const eventName = singleLine(run.event, 'workflow_run.event');
  if (eventName !== 'workflow_dispatch') {
    throw new Error('deployment identity requires a manual trusted dispatch');
  }
  return {
    repository,
    run_id: positiveInt(run.id, 'workflow_run.id'),
    run_attempt: positiveInt(run.run_attempt, 'workflow_run.run_attempt'),
    workflow_id: positiveInt(run.workflow_id, 'workflow_run.workflow_id'),
    event: eventName,
    head_sha: sha(run.head_sha, 'workflow_run.head_sha'),
    head_branch: branch,
  };
}

// The artifact name is GitHub-owned metadata, so it is an independent binding
// of the environment that the receipt claims.
export function assertArtifactBoundReceipt(receipt, artifactName) {
  const item = validateAttestation(receipt);
  const name = singleLine(artifactName, 'artifact name');
  if (!name.startsWith(ARTIFACT_PREFIX)) {
    throw new Error('unexpected deployment attestation artifact: ' + name);
  }
  const environment = name.slice(ARTIFACT_PREFIX.length);
  if (!ENVIRONMENT.test(environment)) fail('artifact name has an invalid environment');
  if (environment !== item.environment_id) {
    throw new Error('artifact environment disagrees with the attestation receipt');
  }
  return item;
}

function validateVerifiedSource(source, repository = REPOSITORY) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('verified source is missing');
  if (source.repository !== repository) fail('verified source repository mismatch');
  const event = singleLine(source.event, 'verified source event');
  if (event !== 'workflow_dispatch') fail('verified source event must be workflow_dispatch');
  const branch = singleLine(source.head_branch, 'verified source branch');
  if (branch !== 'main') fail('verified source branch must be main');
  return {
    repository,
    run_id: positiveInt(source.run_id, 'verified source run_id'),
    run_attempt: positiveInt(source.run_attempt, 'verified source run_attempt'),
    workflow_id: positiveInt(source.workflow_id, 'verified source workflow_id'),
    event,
    head_sha: sha(source.head_sha, 'verified source head_sha'),
    head_branch: branch,
  };
}

// Stable execution identity: the attested deployment plus the exact source
// run that observed it. A replay with the same bytes is idempotent; any
// changed field produces a different identity and a collision is rejected.
export function executionIdentity(item, source) {
  return digest(JSON.stringify({
    environment_id: item.environment_id,
    namespace: item.namespace,
    cluster_context: item.cluster_context,
    gitops_revision: item.gitops_revision,
    observed_at: item.observed_at,
    source_sha: item.source_sha,
    images: item.images.map((image) => ({
      role: image.role, repository: image.repository, tag: image.tag, digest: image.digest,
    })),
    workloads: item.workloads.map((workload) => ({
      role: workload.role, name: workload.name, uid: workload.uid,
      generation: workload.generation, observed_generation: workload.observed_generation,
      image_id: workload.image_id,
    })),
    source_run_id: source.run_id,
    source_run_attempt: source.run_attempt,
  }));
}

export function recordPath(item, source) {
  const date = String(item.observed_at ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('attestation requires an ISO observed_at');
  return [
    'runs',
    date,
    source.run_id + '-' + source.run_attempt,
    'deployment',
    item.environment_id + '.json',
  ].join('/');
}

export function indexPath(item, source) {
  return 'indexes/by-sha/' + item.source_sha + '/deployment/' +
    source.run_id + '-' + source.run_attempt + '-' + item.environment_id + '.json';
}

export function enrichReceipt(receipt, { source, workflowUrl, recordPath: durablePath }) {
  const item = validateAttestation(receipt);
  const verified = validateVerifiedSource(source);
  const path = singleLine(durablePath, 'record path');
  if (path !== recordPath(item, verified)) fail('record path differs from the canonical path');
  return {
    ...item,
    execution_id: executionIdentity(item, verified),
    provenance: {
      verified_source: verified,
      workflow_url: singleLine(workflowUrl, 'workflow_url'),
      record_path: path,
      source_record_sha256: digest(JSON.stringify(item)),
    },
  };
}

export function validateStoredRecord(record) {
  const item = validateAttestation(record);
  const provenance = record?.provenance;
  if (!provenance || typeof provenance !== 'object') fail('stored record provenance is missing');
  const source = validateVerifiedSource(provenance.verified_source);
  singleLine(provenance.workflow_url, 'workflow_url');
  const path = singleLine(provenance.record_path, 'record path');
  if (path !== recordPath(item, source)) fail('stored record path differs from the canonical path');
  const execution = String(record.execution_id ?? '');
  if (!HEX64.test(execution)) fail('stored record execution_id is invalid');
  if (execution !== executionIdentity(item, source)) {
    fail('stored record execution_id does not match canonical deployment identity');
  }
  if (provenance.source_record_sha256 !== digest(JSON.stringify(item))) {
    fail('stored record source digest disagrees with the attestation');
  }
  return { item, source, execution_id: execution, record_path: path };
}

export function indexRecord(record) {
  const { item, source, execution_id: execution, record_path: path } = validateStoredRecord(record);
  return {
    schema_version: 1,
    mode: 'deployment',
    source: {
      repository: source.repository,
      run_id: source.run_id,
      run_attempt: source.run_attempt,
      workflow_id: source.workflow_id,
      head_sha: source.head_sha,
      head_branch: source.head_branch,
    },
    target_sha: item.source_sha,
    environment_id: item.environment_id,
    gitops_revision: item.gitops_revision,
    record: path,
    execution_id: execution,
  };
}

const RECEIPT_FIXTURE = {
  schema_version: 1,
  kind: 'nession_deployment_attestation',
  status: 'Attested',
  environment_id: 'staging-01',
  namespace: 'nession-staging-01',
  cluster_context: 'ci',
  gitops_revision: 'b'.repeat(40),
  observed_at: '2026-10-25T01:00:00Z',
  source_sha: 'abcdef1' + 'a'.repeat(33),
  images: [
    { role: 'agent', repository: 'ghcr.io/bestnathan/nession', tag: 'agent-abcdef1', digest: 'sha256:' + '1'.repeat(64) },
    { role: 'server', repository: 'ghcr.io/bestnathan/nession', tag: 'server-abcdef1', digest: 'sha256:' + '2'.repeat(64) },
    { role: 'ui', repository: 'ghcr.io/bestnathan/nession', tag: 'ui-abcdef1', digest: 'sha256:' + '3'.repeat(64) },
  ],
  workloads: ['agent', 'server', 'ui'].map((role, index) => ({
    role,
    name: 'nession-' + role,
    namespace: 'nession-staging-01',
    uid: 'uid-' + role,
    generation: 3,
    observed_generation: 3,
    ready: true,
    image: 'ghcr.io/bestnathan/nession:' + role + '-abcdef1',
    image_id: 'ghcr.io/bestnathan/nession@sha256:' + String(index + 1).repeat(64),
    digest: 'sha256:' + String(index + 1).repeat(64),
  })),
};

function eventFixture(overrides = {}) {
  return {
    workflow_run: {
      name: WORKFLOW_NAME,
      status: 'completed',
      conclusion: 'success',
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      path: WORKFLOW_PATH,
      id: 40118354470,
      run_attempt: 1,
      workflow_id: 4242,
      repository: { full_name: REPOSITORY },
      head_repository: { full_name: REPOSITORY },
      html_url: 'https://github.com/' + REPOSITORY + '/actions/runs/40118354470',
      ...overrides,
    },
  };
}

function selfTest() {
  const artifact = ARTIFACT_PREFIX + 'staging-01';
  const source = sourceRunIdentity(eventFixture());
  assert.equal(source.run_id, 40118354470);
  assert.equal(source.head_branch, 'main');
  assert.throws(() => sourceRunIdentity(eventFixture({ name: 'E2E / Tests' })), /expected a completed/);
  assert.throws(() => sourceRunIdentity(eventFixture({ conclusion: 'failure' })), /successful terminal/);
  assert.throws(() => sourceRunIdentity(eventFixture({ event: 'push' })), /manual trusted dispatch/);
  assert.throws(() => sourceRunIdentity(eventFixture({ head_branch: 'staging' })), /trusted main/);
  assert.throws(() => sourceRunIdentity(eventFixture({ path: '.github/workflows/other.yml' })),
    /definition path/);
  assert.throws(() => sourceRunIdentity(eventFixture({ run_attempt: 0 })), /run_attempt/);
  assert.throws(() => sourceRunIdentity(eventFixture({
    repository: { full_name: 'other/repo' },
  })), /repository mismatch/);

  const item = assertArtifactBoundReceipt(RECEIPT_FIXTURE, artifact);
  assert.equal(item.environment_id, 'staging-01');
  assert.throws(() => assertArtifactBoundReceipt(RECEIPT_FIXTURE, 'unknown-artifact'),
    /unexpected deployment attestation artifact/);
  assert.throws(() => assertArtifactBoundReceipt(
    { ...RECEIPT_FIXTURE, environment_id: 'staging' }, artifact),
  /artifact environment disagrees/);
  assert.throws(() => assertArtifactBoundReceipt(
    { ...RECEIPT_FIXTURE, workloads: RECEIPT_FIXTURE.workloads.slice(0, 2) }, artifact),
  /missing the ui workload/);

  const path = recordPath(item, source);
  assert.equal(path, 'runs/2026-10-25/40118354470-1/deployment/staging-01.json');
  assert.equal(indexPath(item, source),
    'indexes/by-sha/' + item.source_sha + '/deployment/40118354470-1-staging-01.json');

  const enriched = enrichReceipt(RECEIPT_FIXTURE, {
    source,
    workflowUrl: 'https://github.com/' + REPOSITORY + '/actions/runs/40118354470',
    recordPath: path,
  });
  assert.match(enriched.execution_id, HEX64);
  const stored = validateStoredRecord(enriched);
  assert.equal(stored.record_path, path);
  assert.throws(() => enrichReceipt(RECEIPT_FIXTURE, {
    source, workflowUrl: 'https://example.com/run', recordPath: 'runs/forged.json',
  }), /record path differs/);

  const index = indexRecord(enriched);
  assert.equal(validateRunIndex(index).mode, 'deployment');
  assert.equal(index.target_sha, item.source_sha);
  assert.equal(index.environment_id, 'staging-01');
  assert.equal(index.source.head_sha, 'c'.repeat(40));
  assert.notEqual(index.target_sha, index.source.head_sha);
  assert.throws(() => validateStoredRecord({ ...enriched, execution_id: 'd'.repeat(64) }),
    /execution_id does not match/);
  assert.throws(() => validateStoredRecord({
    ...enriched,
    provenance: { ...enriched.provenance, verified_source: { ...source, run_id: 1 } },
  }), /execution_id does not match|canonical path/);
  assert.throws(() => validateStoredRecord({
    ...enriched,
    provenance: { ...enriched.provenance, source_record_sha256: 'e'.repeat(64) },
  }), /source digest disagrees/);

  console.log('deployment attestation ingest: source, artifact and store bindings passed');
}

function readJson(path, label) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    fail(label + ' is unreadable or invalid JSON: ' + error.message);
  }
}

function main() {
  const command = process.argv[2];
  if (command === 'self-test') return selfTest();
  if (command === 'validate') {
    const record = validateStoredRecord(readJson(process.argv[3], 'record'));
    process.stdout.write(JSON.stringify(record) + '\n');
    return;
  }
  if (command === 'attest') {
    const receipt = readJson(process.argv[3], 'receipt');
    const source = sourceRunIdentity(readJson(process.argv[5] || process.env.GITHUB_EVENT_PATH, 'event'));
    const item = assertArtifactBoundReceipt(receipt, process.argv[4]);
    process.stdout.write(recordPath(item, source) + '\n');
    return;
  }
  if (command === 'enrich') {
    const receipt = readJson(process.argv[3], 'receipt');
    const artifact = process.argv[4];
    const output = process.argv[5];
    const workflowUrl = process.argv[6];
    const durablePath = process.argv[7];
    const event = readJson(process.argv[8] || process.env.GITHUB_EVENT_PATH, 'event');
    const source = sourceRunIdentity(event);
    assertArtifactBoundReceipt(receipt, artifact);
    const enriched = enrichReceipt(receipt, { source, workflowUrl, recordPath: durablePath });
    fs.writeFileSync(output, JSON.stringify(enriched, null, 2) + '\n');
    return;
  }
  if (command === 'index') {
    const record = readJson(process.argv[3], 'record');
    const output = process.argv[4];
    if (!output) fail('index RECORD OUTPUT required');
    const entry = indexRecord(record);
    fs.writeFileSync(output, JSON.stringify(entry, null, 2) + '\n');
    process.stdout.write(indexPath(validateStoredRecord(record).item, validateStoredRecord(record).source) + '\n');
    return;
  }
  fail('usage: node scripts/deployment-attestation-ingest.mjs <self-test|validate FILE|attest RECEIPT ARTIFACT EVENT|enrich RECEIPT ARTIFACT OUT WORKFLOW_URL RECORD_PATH EVENT|index RECORD OUTPUT>');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
