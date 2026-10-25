#!/usr/bin/env node
// #2345: bridge authenticated acceptance-results observations into the durable
// agent-store admission ledger. This never invokes an Agent or writes an Issue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordE2EFailureObservation } from './lib/agent/orchestration/e2e-failure-ledger.mjs';
import { isTrustedMainFullEvent } from './e2e-regression-policy.mjs';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/e2e-full-regression.yml';
const SHA40 = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRAME = /^[A-Za-z0-9_.-]{1,100}\.spec\.[cm]?[jt]s:[1-9][0-9]{0,5}(?::[1-9][0-9]{0,5})?$/;
function fail(message) { throw new Error('e2e-failure-admission-ingest: ' + message); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }

function verifyRecord(record) {
  const source = record?.source;
  if (record?.kind !== 'e2e_full_failure_observation' ||
      record?.trust !== 'authenticated_github_run_and_artifact_digest' ||
      record?.evaluation !== 'NOT_EVALUATED' ||
      record?.agent_dispatch !== 'NOT_AUTHORIZED' ||
      source?.repository !== REPO || source?.workflow_path !== WORKFLOW ||
      !isTrustedMainFullEvent(source?.event) || source?.branch !== 'main' ||
      source?.conclusion !== 'failure' || !positive(source?.run_id) ||
      !positive(source?.run_attempt) || !SHA40.test(source?.source_sha ?? '') ||
      !Number.isFinite(Date.parse(source?.completed_at ?? '')) ||
      !positive(record?.artifact?.id) || !DIGEST.test(record?.artifact?.digest ?? '') ||
      !Array.isArray(record?.candidate?.results) || record.candidate.results.length > 64) {
    fail('record is not an authenticated exact-run failure observation');
  }
  const ids = new Set();
  for (const item of record.candidate.results) {
    if (!item || !ID.test(item.id ?? '') || ids.has(item.id) ||
        !Number.isSafeInteger(item.failed) || item.failed < 0 ||
        !Array.isArray(item.failures ?? [])) fail('invalid or duplicate per-ID result');
    ids.add(item.id);
    for (const sig of item.failures ?? []) {
      if (sig?.kind !== 'assertion_failed' ||
          sig?.assertion_code !== 'playwright_unexpected' ||
          !FRAME.test(sig?.stable_frame ?? '') ||
          sig?.affected_invariant !== item.id || sig?.environment_specific !== false ||
          Object.keys(sig).sort().join(',') !==
            ['affected_invariant','assertion_code','environment_specific','kind','stable_frame'].sort().join(',')) {
        fail('malformed or unsafe sanitized signature');
      }
    }
  }
  return record;
}

function buildObservations(record) {
  const source = {
    repository: record.source.repository,
    workflow_path: record.source.workflow_path,
    event: record.source.event,
    branch: record.source.branch,
    conclusion: record.source.conclusion,
    run_id: record.source.run_id,
    run_attempt: record.source.run_attempt,
    target_sha: record.source.source_sha,
    completed_at: record.source.completed_at,
    acceptance_record_path: `runs/${record.source.source_sha}/full-regression/${record.source.run_id}-${record.source.run_attempt}.json`,
  };
  const artifact = { id: record.artifact.id, digest: record.artifact.digest };
  const observations = [];
  for (const item of record.candidate.results) {
    if (item.failed < 1) continue;
    const signatures = item.failures ?? [];
    if (!signatures.length) {
      observations.push({
        authenticated: true, source, artifact, classification: 'unclassified_test_failure',
        results: [{ test_id: item.id, kind: 'harness_error', actionable: false }],
      });
      continue;
    }
    for (const signature of signatures) {
      observations.push({
        authenticated: true, source, artifact, classification: 'candidate_test_failure',
        results: [{
          test_id: item.id, kind: signature.kind, actionable: true,
          assertion_code: signature.assertion_code,
          stable_frame: signature.stable_frame,
          affected_invariant: signature.affected_invariant,
          environment_specific: signature.environment_specific,
        }],
      });
    }
  }
  if (!observations.length) {
    observations.push({
      authenticated: true, source, artifact, classification: 'setup_or_ci_error',
      results: [{ test_id: 'full-regression-report', kind: 'environment_error', actionable: false }],
    });
  }
  return observations;
}

export function ingestRecord(record, storeRoot, options = {}) {
  verifyRecord(record);
  if (typeof storeRoot !== 'string' || !path.isAbsolute(storeRoot) ||
      !fs.statSync(storeRoot).isDirectory()) fail('absolute existing agent-store checkout required');
  const observations = buildObservations(record);
  const outcomes = observations.map(observation =>
    recordE2EFailureObservation(storeRoot, observation, options));
  return {
    schema_version: 1,
    kind: 'e2e_failure_admission_batch',
    source_run_id: record.source.run_id,
    source_attempt: record.source.run_attempt,
    source_sha: record.source.source_sha,
    outcomes,
    dispatch_allowed: false,
    agent_invocations: 0,
    bug_writes: 0,
  };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-admission-bridge-'));
  try {
    const sha = 'a'.repeat(40), d = 'b'.repeat(64);
    const record = {
      schema_version: 1, kind: 'e2e_full_failure_observation',
      trust: 'authenticated_github_run_and_artifact_digest',
      evaluation: 'NOT_EVALUATED', agent_dispatch: 'NOT_AUTHORIZED',
      source: { repository: REPO, workflow_path: WORKFLOW, workflow_id: 9,
        event: 'schedule', branch: 'main', run_id: 501, run_attempt: 2,
        source_sha: sha, conclusion: 'failure', completed_at: '2026-10-24T12:00:00Z' },
      artifact: { id: 77, digest: 'sha256:' + d },
      candidate: { status: 'FAILED_TESTS_OBSERVED', results: [
        { id: 'terminal-attach', total: 1, failed: 1, skipped: 0, flaky: 0, expected: 0, other: 0,
          failures: [{ kind: 'assertion_failed', assertion_code: 'playwright_unexpected',
            stable_frame: 'terminal-attach.spec.ts:42:9', affected_invariant: 'terminal-attach',
            environment_specific: false }] },
        { id: 'session-lifecycle', total: 1, failed: 1, skipped: 0, flaky: 0, expected: 0, other: 0,
          failures: [{ kind: 'assertion_failed', assertion_code: 'playwright_unexpected',
            stable_frame: 'session-lifecycle.spec.ts:18', affected_invariant: 'session-lifecycle',
            environment_specific: false }] },
      ] },
    };
    const first = ingestRecord(record, root, { now: '2026-10-24T12:01:00Z' });
    assert.equal(first.outcomes.length, 2);
    assert.ok(first.outcomes.every(x => x.status === 'ANALYSIS_CLAIMED'));
    assert.equal(first.dispatch_allowed, false);
    assert.equal(first.agent_invocations, 0);
    assert.equal(first.bug_writes, 0);
    const replay = ingestRecord(record, root, { now: '2026-10-24T12:02:00Z' });
    assert.ok(replay.outcomes.every(x => x.status === 'ANALYSIS_IN_FLIGHT'));
    assert.equal(replay.outcomes[0].analysis_id, first.outcomes[0].analysis_id);
    // The immediate post-promotion push route (#2323 SC-12) must join the same
    // fingerprint claim as the scheduled route instead of dispatching again.
    const pushRoute = ingestRecord({ ...record,
      source: { ...record.source, event: 'push', run_id: 502,
        completed_at: '2026-10-24T12:04:00Z' } }, root, { now: '2026-10-24T12:05:00Z' });
    assert.ok(pushRoute.outcomes.every(x => x.status === 'ANALYSIS_IN_FLIGHT'));
    assert.deepEqual(pushRoute.outcomes.map(x => x.analysis_id),
      first.outcomes.map(x => x.analysis_id));
    assert.throws(() => ingestRecord({ ...record,
      source: { ...record.source, event: 'pull_request' } }, root), /authenticated/);
    assert.throws(() => ingestRecord({ ...record, trust: 'UNATTESTED_ARTIFACT_ONLY' }, root), /authenticated/);
    assert.throws(() => ingestRecord({ ...record, source: { ...record.source, source_sha: 'main' } }, root), /authenticated/);
    const unsafe = structuredClone(record);
    unsafe.candidate.results[0].failures[0].assertion_text = 'secret';
    assert.throws(() => ingestRecord(unsafe, root), /malformed or unsafe/);
    const noSignatures = structuredClone(record);
    noSignatures.candidate.results[0].failures = [];
    const triage = ingestRecord(noSignatures, root, { now: '2026-10-24T12:03:00Z' });
    assert.equal(triage.outcomes[0].status, 'TRIAGE_REQUIRED');
    assert.equal(triage.dispatch_allowed, false);
    console.log('e2e-failure-admission-ingest self-test: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  if (process.argv[2] !== 'ingest' || process.argv.length !== 6) {
    fail('usage: self-test | ingest RECORD_JSON ABSOLUTE_AGENT_STORE_ROOT OUTPUT_JSON');
  }
  const [, , , recordPath, storeRoot, outputPath] = process.argv;
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const result = ingestRecord(record, storeRoot);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ outcomes: result.outcomes.map(x => ({
    status: x.status, fingerprint: x.fingerprint, analysis_id: x.analysis_id ?? null,
    observation_path: x.observation_path,
  })), dispatch_allowed: false, agent_invocations: 0, bug_writes: 0 }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
