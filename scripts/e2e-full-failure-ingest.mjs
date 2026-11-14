#!/usr/bin/env node
// Main-owned authenticated intake for independent Main Full failures (#3465):
// periodic schedule, explicit Main manual recheck, legacy Main-push receipts.
// The source run's dynamic name is not the trusted workflow identity. This
// records observations only, never a Pass or an unauthorized Agent action.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isTrustedMainFullEvent, TRUSTED_MAIN_FULL_EVENTS } from './e2e-regression-policy.mjs';

const REPO = 'BestNathan/nession';
const WORKFLOW_PATH = '.github/workflows/e2e-full-regression.yml';
const WORKFLOW_NAME = 'E2E / Full Regression';
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const reject = message => { throw new Error('e2e full-failure ingest rejected: ' + message); };

// GitHub REST may put the run-name in run.name instead of the workflow's
// static name. Bind the only allowed dynamic titles to the Main source SHA.
// Manual source-ref dispatches to other branches must never be recorded as
// failures of Main (their run.head_sha still points at the dispatcher Main).
function canonicalMainFullRunName(run) {
  const sha=run?.head_sha;
  if(!SHA40.test(sha??''))return false;
  if(run.event==='schedule'||run.event==='push')
    return run.name===WORKFLOW_NAME||run.name==='Full Regression main@'+sha;
  if(run.event==='workflow_dispatch')
    return run.name==='Convergence Full main@'+sha;
  return false;
}

function verify({ event, run, workflow, jobs, artifacts, candidate, archiveSha256 }) {
  assert.equal(event?.repository?.full_name, REPO);
  assert.equal(event?.workflow_run?.id, run?.id);
  assert.equal(event?.workflow_run?.run_attempt, run?.run_attempt);
  assert.equal(event?.workflow_run?.head_sha, run?.head_sha);
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.equal(run?.path, WORKFLOW_PATH);
  assert.ok(canonicalMainFullRunName(run),
    'run name/event must identify the exact Main Full source SHA');
  assert.equal(workflow?.path, WORKFLOW_PATH);
  assert.equal(workflow?.name, WORKFLOW_NAME);
  assert.equal(workflow?.id, run?.workflow_id);
  assert.ok(isTrustedMainFullEvent(run?.event), 'only trusted Main Full run events are eligible');
  assert.equal(run?.head_branch, 'main');
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'failure');
  assert.ok(SHA40.test(run?.head_sha ?? ''));
  assert.ok(positive(run?.id) && positive(run?.run_attempt) && positive(run?.workflow_id));

  const matchingJobs = (jobs?.jobs ?? []).filter(j => j.name === 'full' &&
    j.run_id === run.id && j.run_attempt === run.run_attempt);
  assert.equal(matchingJobs.length, 1, 'exact Full Regression job/attempt required');
  const job = matchingJobs[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'failure');
  assert.equal(job.head_sha, run.head_sha);
  assert.ok(Date.parse(job.started_at) <= Date.parse(job.completed_at));

  const expectedName = `full-regression-${run.id}-${run.run_attempt}`;
  const matchingArtifacts = (artifacts?.artifacts ?? []).filter(a =>
    a.name === expectedName && a.expired === false && a.workflow_run?.id === run.id);
  assert.equal(matchingArtifacts.length, 1, 'exact non-expired run/attempt artifact required');
  const artifact = matchingArtifacts[0];
  assert.ok(positive(artifact.id) && positive(artifact.size_in_bytes));
  assert.ok(artifact.size_in_bytes <= 1024 * 1024 * 1024, 'artifact exceeds size limit');
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(artifact.workflow_run?.head_sha, run.head_sha);
  const created = Date.parse(artifact.created_at);
  assert.ok(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at),
    'artifact must be created during exact failed attempt');
  assert.equal(archiveSha256, artifact.digest.slice(7), 'downloaded artifact bytes do not match GitHub digest');

  assert.equal(candidate?.schema_version, 1);
  assert.equal(candidate?.kind, 'e2e_full_failure_candidate');
  assert.equal(candidate?.provenance, 'UNATTESTED_ARTIFACT_ONLY');
  assert.equal(candidate?.run_id, run.id);
  assert.equal(candidate?.run_attempt, run.run_attempt);
  assert.equal(candidate?.target_sha, run.head_sha, 'candidate target is not the scheduled source SHA');
  assert.ok(['FAILED_TESTS_OBSERVED','UNCLASSIFIED_FAILURE','NON_PASS_OR_UNKNOWN_OBSERVED',
    'NO_FAILED_TESTS_OBSERVED_NOT_PASS','REPORT_UNAVAILABLE'].includes(candidate.status));
  assert.ok(Array.isArray(candidate.results) && candidate.results.length <= 64);
  const ids = new Set();
  for (const item of candidate.results) {
    assert.ok(item && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id ?? ''));
    assert.ok(!ids.has(item.id), 'duplicate E2E ID');
    ids.add(item.id);
    for (const k of ['total','failed','skipped','flaky','expected','other']) {
      assert.ok(Number.isSafeInteger(item[k]) && item[k] >= 0, 'invalid count: ' + k);
    }
    assert.equal(item.failed + item.skipped + item.flaky + item.expected + item.other, item.total);
    if (item.failures !== undefined) {
      assert.ok(Array.isArray(item.failures) && item.failures.length <= 8, 'invalid bounded failure signatures');
      for (const failure of item.failures) {
        assert.ok(failure && failure.kind === 'assertion_failed' &&
          failure.assertion_code === 'playwright_unexpected' &&
          /^[A-Za-z0-9_.-]{1,100}\.spec\.[cm]?[jt]s:[1-9][0-9]{0,5}(?::[1-9][0-9]{0,5})?$/.test(failure.stable_frame ?? '') &&
          failure.affected_invariant === item.id &&
          failure.environment_specific === false,
          'unsafe or malformed sanitized failure signature');
        assert.deepEqual(Object.keys(failure).sort(),
          ['affected_invariant','assertion_code','environment_specific','kind','stable_frame'].sort(),
          'unexpected failure signature fields');
      }
    }
  }
  const record = {
    schema_version: 1,
    kind: 'e2e_full_failure_observation',
    trust: 'authenticated_github_run_and_artifact_digest',
    evaluation: 'NOT_EVALUATED',
    agent_dispatch: 'NOT_AUTHORIZED',
    source: { repository: REPO, workflow_path: WORKFLOW_PATH, workflow_id: run.workflow_id,
      event: run.event, branch: run.head_branch, run_id: run.id, run_attempt: run.run_attempt,
      source_sha: run.head_sha, conclusion: run.conclusion, completed_at: job.completed_at, run_url: run.html_url },
    artifact: { id: artifact.id, name: artifact.name, digest: artifact.digest,
      size_bytes: artifact.size_in_bytes, expires_at: artifact.expires_at,
      retention: 'GitHub Actions artifact; time-limited' },
    candidate: {
      status: candidate.status,
      observed_tests: Number.isSafeInteger(candidate.observed_tests) ? candidate.observed_tests : null,
      unknown_files: Number.isSafeInteger(candidate.unknown_files) ? candidate.unknown_files : null,
      results: candidate.results,
    },
    evidence: { archive_sha256: archiveSha256, candidate_sha256: digest(JSON.stringify(candidate)) },
  };
  const recordPath = `runs/${run.head_sha}/full-regression/${run.id}-${run.run_attempt}.json`;
  const indexPath = `indexes/by-sha/${run.head_sha}/full-regression/${run.id}-${run.run_attempt}.json`;
  const index = { schema_version: 1, kind: 'e2e_full_failure_observation_index',
    source_sha: run.head_sha, run_id: run.id, run_attempt: run.run_attempt,
    record_path: recordPath, record_sha256: digest(JSON.stringify(record, null, 2) + '\n') };
  return { record, index, record_path: recordPath, index_path: indexPath };
}
function selfTest() {
  const sha = 'a'.repeat(40), d = 'b'.repeat(64);
  const run = { id: 501, run_attempt: 2, workflow_id: 9, path: WORKFLOW_PATH,
    name: 'Full Regression main@'+sha,
    event: 'schedule', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'failure',
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, html_url: 'https://example.invalid/run/501' };
  const job = { name: 'full', run_id: 501, run_attempt: 2, head_sha: sha, status: 'completed',
    conclusion: 'failure', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:02:00Z' };
  const artifact = { id: 7, name: 'full-regression-501-2', expired: false, size_in_bytes: 100,
    digest: 'sha256:' + d, created_at: '2026-01-01T00:01:00Z', expires_at: '2026-01-15T00:00:00Z',
    workflow_run: { id: 501, head_sha: sha } };
  const candidate = { schema_version: 1, kind: 'e2e_full_failure_candidate',
    provenance: 'UNATTESTED_ARTIFACT_ONLY', run_id: 501, run_attempt: 2, target_sha: sha,
    status: 'FAILED_TESTS_OBSERVED', results: [{ id: 'terminal-attach', total: 2,
      failed: 1, skipped: 0, flaky: 0, expected: 1, other: 0,
      failures: [{ kind: 'assertion_failed', assertion_code: 'playwright_unexpected',
        stable_frame: 'terminal-attach.spec.ts:42:9', affected_invariant: 'terminal-attach',
        environment_specific: false }] }] };
  const input = { event: { repository: { full_name: REPO }, workflow_run: { id: 501,
    run_attempt: 2, head_sha: sha } }, run, workflow: { id: 9, path: WORKFLOW_PATH, name: WORKFLOW_NAME },
    jobs: { jobs: [job] }, artifacts: { artifacts: [artifact] }, candidate, archiveSha256: d };
  const result = verify(input);
  assert.equal(result.record.agent_dispatch, 'NOT_AUTHORIZED');
  assert.equal(result.record.candidate.results[0].failures[0].stable_frame, 'terminal-attach.spec.ts:42:9');
  assert.match(result.record_path, new RegExp(sha));
  // Historical canonical names, dynamic schedule/push names, and explicit
  // exact-Main manual runs all reach the same authenticated dedup pipeline.
  for (const event of TRUSTED_MAIN_FULL_EVENTS) {
    const name=event==='workflow_dispatch'
      ? 'Convergence Full main@'+sha : 'Full Regression main@'+sha;
    assert.equal(verify({ ...input, run: { ...run, event, name } }).record.source.event,
      event);
  }
  assert.equal(verify({...input,run:{...run,name:WORKFLOW_NAME}}).record.source.event,
    'schedule','legacy static-name source remains readable');
  // The workflow guard is the first hop of the same policy. Keep it in parity
  // with the executable owner instead of silently dropping a route.
  const guard = fs.readFileSync(
    new URL('../.github/workflows/e2e-full-failure-ingest.yml', import.meta.url), 'utf8');
  for (const event of TRUSTED_MAIN_FULL_EVENTS) {
    assert.ok(guard.includes(`github.event.workflow_run.event == '${event}'`),
      `workflow guard must admit the ${event} Full source route`);
  }
  assert.ok(guard.includes("format('Full Regression main@{0}'"),
    'workflow must not reject REST dynamic Main schedule names');
  assert.ok(guard.includes("format('Convergence Full main@{0}'"),
    'manual Main Full must be source-SHA bound in intake routing');
  // #3465 real regression: workflow_dispatch with default target_ref=main
  // and omitted target_sha used to name the run "Convergence Full main@".
  // Intake correctly rejected that name, silently losing failure evidence.
  // Require the producer to pin BOTH its run-name and actual checkout to
  // github.sha; otherwise restoring only the consumer would be unsafe.
  const producer = fs.readFileSync(
    new URL('../.github/workflows/e2e-full-regression.yml', import.meta.url), 'utf8');
  assert.ok(producer.includes(
    "inputs.target_sha || (inputs.target_ref == 'main' && github.sha) || 'tip'"),
    'manual Main default run-name must bind the immutable dispatch SHA');
  assert.ok(producer.includes(
    "github.event_name == 'workflow_dispatch' && inputs.target_ref == 'main' && inputs.target_sha == ''"),
    'manual Main default checkout must pin the same immutable dispatch SHA');
  assert.ok(producer.includes("github.event_name == 'schedule'"),
    'Main schedule still pins the immutable event SHA');
  assert.ok(!/\n  push:\s*\n\s*branches: \[main\]/.test(producer),
    'Main push must not re-enable Full as an implicit convergence dependency');
  for (const bad of [
    { ...input, run: { ...run, event: 'pull_request' } },
    { ...input, run: { ...run, name: 'Full Regression main@'+'c'.repeat(40) } },
    { ...input, run: { ...run, event:'workflow_dispatch',
      name:'Convergence Full chore/staging-sync@'+sha } },
    { ...input, run: { ...run, event:'workflow_dispatch',name:WORKFLOW_NAME } },
    { ...input, run: { ...run, event:'workflow_dispatch',name:'Convergence Full main@' } },
    { ...input, run: { ...run, event:'workflow_dispatch',
      name:'Convergence Full staging@'+sha } },
    { ...input, run: { ...run, head_sha: 'c'.repeat(40) } },
    { ...input, archiveSha256: '0'.repeat(64) },
    { ...input, artifacts: { artifacts: [{ ...artifact, workflow_run: { id: 999, head_sha: sha } }] } },
    { ...input, candidate: { ...candidate, target_sha: 'c'.repeat(40) } },
    { ...input, candidate: { ...candidate, results: [candidate.results[0], candidate.results[0]] } },
  ]) assert.throws(() => verify(bad));
  console.log('e2e-full-failure-ingest self-test: PASS');
}
function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'verify-json' && args.length === 2) {
    const input = JSON.parse(fs.readFileSync(args[0], 'utf8'));
    const result = verify(input);
    fs.mkdirSync(args[1], { recursive: true });
    fs.writeFileSync(path.join(args[1], 'record.json'), JSON.stringify(result.record, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(args[1], 'index.json'), JSON.stringify(result.index, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ record: result.record_path, index: result.index_path }));
    return;
  }
  reject('usage: self-test | verify-json INPUT.json OUT_DIR');
}
try { main(); } catch (e) { console.error(e.stack ?? e); process.exitCode = 2; }
