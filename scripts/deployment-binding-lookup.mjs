#!/usr/bin/env node
// Owner: #2323 SC-04. Select the trusted deployment binding for an Acceptance
// run from the append-only store records. The caller must supply the actual
// records read from acceptance-results; this module never trusts a path or a
// receipt by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { enrichReceipt, validateStoredRecord } from './deployment-attestation-ingest.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;
const RECORD_PATH = /^runs\/\d{4}-\d{2}-\d{2}\/\d+-\d+\/deployment\/[a-z][a-z0-9-]{0,62}\.json$/;

function fail(message) {
  throw new Error(message);
}

// Choose the newest authenticated attestation for exactly one environment and
// source SHA. A stale deployment (different SHA) or a tie between two distinct
// executions is not a trustworthy binding.
export function selectDeploymentBinding({ environmentId, sourceSha, records }) {
  const environment = String(environmentId ?? '');
  if (!ENVIRONMENT.test(environment)) fail('invalid deployment environment');
  if (!SHA.test(String(sourceSha ?? ''))) fail('source SHA must be a 40-character hex SHA');
  if (!Array.isArray(records)) fail('deployment records must be an array');

  const candidates = [];
  for (const entry of records) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('deployment record entry must be an object');
    }
    const path = String(entry.path ?? '');
    if (!RECORD_PATH.test(path)) fail('unsafe deployment record path: ' + path);
    const { item, source, execution_id } = validateStoredRecord(entry.record);
    if (item.environment_id !== environment) continue;
    const observedAt = Date.parse(item.observed_at);
    if (!Number.isFinite(observedAt)) fail('deployment record has an invalid observation timestamp');
    candidates.push({ path, item, source, execution_id, observedAt });
  }
  if (candidates.length === 0) {
    fail('no deployment attestation exists for environment ' + environment);
  }
  const exact = candidates.filter((candidate) => candidate.item.source_sha === sourceSha);
  if (exact.length === 0) {
    const deployed = [...new Set(candidates.map((candidate) => candidate.item.source_sha))];
    fail('deployment attestation for environment ' + environment +
      ' does not match the requested source SHA (deployed: ' + deployed.join(', ') + ')');
  }
  const newest = Math.max(...exact.map((candidate) => candidate.observedAt));
  const top = exact.filter((candidate) => candidate.observedAt === newest);
  if (new Set(top.map((candidate) => candidate.execution_id)).size !== 1) {
    fail('ambiguous deployment attestation at the newest observation timestamp');
  }
  const chosen = top[0];
  return {
    environment_id: chosen.item.environment_id,
    attested: true,
    attestation_execution_id: chosen.execution_id,
    gitops_revision: chosen.item.gitops_revision,
    image_digests: Object.fromEntries(
      chosen.item.images.map((image) => [image.role, image.digest])),
    source_sha: chosen.item.source_sha,
    attestation_path: chosen.path,
  };
}

const RECEIPT = {
  schema_version: 1,
  kind: 'nession_deployment_attestation',
  status: 'Attested',
  environment_id: 'staging-01',
  namespace: 'nession-staging-01',
  cluster_context: 'ci',
  gitops_revision: 'b'.repeat(40),
  observed_at: '2026-10-25T01:00:00Z',
  source_sha: 'a'.repeat(40),
  images: [
    { role: 'agent', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'agent-aaaaaaa', digest: 'sha256:' + '1'.repeat(64) },
    { role: 'server', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'server-aaaaaaa', digest: 'sha256:' + '2'.repeat(64) },
    { role: 'ui', declared_repository: 'ghcr.io/bestnathan/nession', repository: 'ghcr.io/bestnathan/nession', tag: 'ui-aaaaaaa', digest: 'sha256:' + '3'.repeat(64) },
  ],
  workloads: ['agent', 'server', 'ui'].map((role, index) => ({
    role,
    name: 'nession-' + role,
    namespace: 'nession-staging-01',
    uid: 'uid-' + role,
    generation: 3,
    observed_generation: 3,
    ready: true,
    image: 'ghcr.io/bestnathan/nession:' + role + '-aaaaaaa',
    image_id: 'ghcr.io/bestnathan/nession@sha256:' + String(index + 1).repeat(64),
    declared_repository: 'ghcr.io/bestnathan/nession',
    repository: 'ghcr.io/bestnathan/nession',
    digest: 'sha256:' + String(index + 1).repeat(64),
  })),
};

function storedRecord({ runId = 100, observedAt = '2026-10-25T01:00:00Z', sourceSha = 'a'.repeat(40), environment = 'staging-01' } = {}) {
  // Build the enriched record exactly as the trusted ingester would.
  const item = {
    ...RECEIPT,
    environment_id: environment,
    observed_at: observedAt,
    source_sha: sourceSha,
  };
  const source = {
    repository: 'BestNathan/nession',
    run_id: runId,
    run_attempt: 1,
    workflow_id: 42,
    event: 'workflow_dispatch',
    head_sha: 'c'.repeat(40),
    head_branch: 'main',
  };
  return enrichReceipt(item, {
    source,
    workflowUrl: 'https://github.com/BestNathan/nession/actions/runs/' + runId,
    recordPath: 'runs/2026-10-25/' + runId + '-1/deployment/' + environment + '.json',
  });
}

function selfTest() {
  const path100 = 'runs/2026-10-25/100-1/deployment/staging-01.json';
  const path101 = 'runs/2026-10-25/101-1/deployment/staging-01.json';
  const path200 = 'runs/2026-10-25/200-1/deployment/staging.json';

  const binding = selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'a'.repeat(40),
    records: [{ path: path100, record: storedRecord() }],
  });
  assert.equal(binding.environment_id, 'staging-01');
  assert.equal(binding.attested, true);
  assert.equal(binding.attestation_path, path100);
  assert.equal(binding.image_digests.server, 'sha256:' + '2'.repeat(64));
  assert.match(binding.attestation_execution_id, /^[0-9a-f]{64}$/);

  // A newer record for the same SHA wins.
  const newer = selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'a'.repeat(40),
    records: [
      { path: path100, record: storedRecord() },
      { path: path101, record: storedRecord({ runId: 101, observedAt: '2026-10-25T02:00:00Z' }) },
    ],
  });
  assert.equal(newer.attestation_path, path101);

  // Ignore other environments and reject a stale source SHA.
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'd'.repeat(40),
    records: [{ path: path100, record: storedRecord() }],
  }), /does not match the requested source SHA/);
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging',
    sourceSha: 'd'.repeat(40),
    records: [{ path: path100, record: storedRecord() }],
  }), /no deployment attestation exists for environment staging/);

  // Two different executions at the same newest timestamp are ambiguous.
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'a'.repeat(40),
    records: [
      { path: path100, record: storedRecord() },
      { path: path101, record: storedRecord({ runId: 101 }) },
    ],
  }), /ambiguous deployment attestation/);

  assert.throws(() => selectDeploymentBinding({
    environmentId: 'Staging_01',
    sourceSha: 'a'.repeat(40),
    records: [{ path: path100, record: storedRecord() }],
  }), /invalid deployment environment/);
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'short',
    records: [{ path: path100, record: storedRecord() }],
  }), /40-character/);
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'a'.repeat(40),
    records: [{ path: '../../etc/passwd', record: storedRecord() }],
  }), /unsafe deployment record path/);
  assert.throws(() => selectDeploymentBinding({
    environmentId: 'staging-01',
    sourceSha: 'a'.repeat(40),
    records: [{ path: path100, record: { ...storedRecord(), execution_id: 'f'.repeat(64) } }],
  }), /execution_id does not match/);

  console.log('deployment binding lookup: environment/SHA selection and ambiguity fixtures passed');
}

// Read compact deployment records from a checked-out acceptance-results tree.
// Only the canonical deployment record path participates; other modes and
// large artifacts are ignored.
export function collectDeploymentRecords(root) {
  const records = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\/deployment\/[a-z][a-z0-9-]{0,62}\.json$/.test(full)) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        records.push({ path: relative, record: JSON.parse(fs.readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(root);
  return records;
}

function main() {
  if (process.argv[2] === 'self-test') {
    selfTest();
    return;
  }
  if (process.argv[2] === 'collect') {
    const [root, output] = process.argv.slice(3);
    if (!root || !output) throw new Error('usage: collect STORE_ROOT OUTPUT');
    fs.writeFileSync(output, JSON.stringify(collectDeploymentRecords(root)) + '\n');
    return;
  }
  if (process.argv[2] === 'select') {
    const [environmentId, sourceSha, recordsFile, output] = process.argv.slice(3);
    if (!environmentId || !sourceSha || !recordsFile) {
      throw new Error('usage: select ENVIRONMENT SOURCE_SHA RECORDS_JSON [OUTPUT]');
    }
    const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'));
    const binding = selectDeploymentBinding({ environmentId, sourceSha, records });
    const json = JSON.stringify(binding, null, 2) + '\n';
    if (output) fs.writeFileSync(output, json);
    else process.stdout.write(json);
    return;
  }
  throw new Error('usage: self-test | collect STORE_ROOT OUTPUT | select ENVIRONMENT SOURCE_SHA RECORDS_JSON [OUTPUT]');
}

if (process.argv[1]?.endsWith('deployment-binding-lookup.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
