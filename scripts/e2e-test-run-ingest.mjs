#!/usr/bin/env node
// Main-controlled, append-only metadata-only ingestion for *push* E2E Tests.
// PR runs (often synthetic merge refs) are intentionally excluded until their
// precise checked-out SHA can be independently attested.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRunIndex } from './run-record-index-contract.mjs';

const REPO = 'BestNathan/nession';
const API = 'https://api.github.com/repos/' + REPO;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
function assertSource(event, run, workflow) {
  assert.equal(event?.repository?.full_name, REPO);
  assert.equal(event?.workflow_run?.id, run.id);
  assert.equal(event?.workflow_run?.run_attempt, run.run_attempt);
  assert.equal(event?.workflow_run?.head_sha, run.head_sha);
  assert.equal(event?.workflow_run?.event, run.event);
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO);
  assert.equal(run.workflow_id, workflow.id);
  assert.equal(workflow.path, '.github/workflows/e2e.yml');
  assert.equal(run.path, '.github/workflows/e2e.yml');
  assert.equal(run.event, 'push', 'untrusted PR/dispatch source is not an eligible Test Run');
  assert.ok(['staging','main'].includes(run.head_branch), 'untrusted source branch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.match(run.head_sha, HEX40);
  assert.ok(positive(run.id) && positive(run.run_attempt) && positive(run.workflow_id));
  assert.ok(Number.isFinite(Date.parse(run.created_at)));
  assert.equal(run.head_commit?.id, run.head_sha);
}
function requireArtifact(raw, run) {
  assert.equal(raw.name, 'playwright-report');
  assert.ok(positive(raw.id) && positive(raw.size_in_bytes));
  assert.ok(raw.size_in_bytes <= 1024 * 1024 * 1024, 'oversized artifact');
  assert.equal(raw.expired, false, 'artifact already expired');
  assert.match(raw.digest, /^sha256:[a-f0-9]{64}$/, 'artifact digest not verified');
  assert.ok(Number.isFinite(Date.parse(raw.expires_at)));
  assert.ok(Date.parse(raw.expires_at) > Date.parse(run.created_at));
  return { artifact_id: raw.id, name: raw.name, size_bytes: raw.size_in_bytes,
    sha256: raw.digest.slice(7), expires_at: raw.expires_at,
    durability: 'GitHub Actions artifact; time-limited, not indefinitely archived' };
}
function requireJob(jobs, run) {
  const matches = jobs.filter(j => j.name === 'e2e' && j.run_id === run.id);
  assert.equal(matches.length, 1, 'missing or duplicate exact E2E job');
  const job = matches[0];
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  return { job_id: job.id, name: 'e2e', conclusion: 'success' };
}
function recordFor(event, run, workflow, tree, jobs, artifacts) {
  assertSource(event, run, workflow);
  assert.match(tree.sha, HEX40);
  const sourceTree = tree.tree.find(x => x.path === 'e2e/tests/browser' && x.type === 'tree');
  assert.ok(sourceTree && HEX40.test(sourceTree.sha), 'missing authentic Playwright source tree');
  const proof = requireJob(jobs, run);
  const found = artifacts.filter(x => x.name === 'playwright-report');
  assert.equal(found.length, 1, 'missing or ambiguous report artifact');
  const artifact = requireArtifact(found[0], run);
  const date = run.created_at.slice(0, 10);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  const name = run.id + '-' + run.run_attempt;
  const recordPath = 'runs/' + date + '/' + name + '/test/playwright.json';
  const indexPath = 'indexes/by-sha/' + run.head_sha + '/test/' + name + '-playwright.json';
  const source = { repository: REPO, workflow_id: run.workflow_id,
    run_id: run.id, run_attempt: run.run_attempt, head_sha: run.head_sha,
    head_branch: run.head_branch, event: run.event };
  const identity = { schema_version: 1, kind: 'e2e_test_run', mode: 'test',
    target_sha: run.head_sha, source_tree_sha: sourceTree.sha,
    run_id: run.id, run_attempt: run.run_attempt, source,
    started_at: run.created_at, status: 'Completed', evaluation: null,
    test_job: proof, evidence: artifact };
  const executionId = sha256(JSON.stringify(identity));
  const record = { ...identity, execution_id: executionId };
  const recordBytes = JSON.stringify(record, null, 2) + '\n';
  const index = makeRunIndex({ schema_version: 1, mode: 'test', suite: 'playwright',
    source, record: recordPath, target_sha: run.head_sha, source_tree_sha: sourceTree.sha,
    execution_id: executionId, record_sha256: sha256(recordBytes),
    artifact_sha256: artifact.sha256, artifact_expires_at: artifact.expires_at });
  return { recordPath, indexPath, recordBytes,
    indexBytes: JSON.stringify(index, null, 2) + '\n' };
}
async function github(route) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  assert.ok(token, 'trusted GitHub API credential required');
  const response = await fetch(API + route, { headers: {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'User-Agent': 'nession-trusted-test-run-ingest',
  }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('GitHub source metadata lookup failed: ' + response.status);
  return response.json();
}
async function create(eventFile, recordFile, indexFile, outputFile) {
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const id = event?.workflow_run?.id;
  assert.ok(positive(id), 'invalid GitHub source-run ID');
  const [run, workflow, jobs, artifacts] = await Promise.all([
    github('/actions/runs/' + id),
    github('/actions/workflows/e2e.yml'),
    github('/actions/runs/' + id + '/jobs?per_page=100'),
    github('/actions/runs/' + id + '/artifacts?per_page=100'),
  ]);
  assertSource(event, run, workflow);
  assert.ok(jobs.total_count <= 100 && artifacts.total_count <= 100,
    'unverified paginated source enumeration');
  const commit = await github('/git/commits/' + run.head_sha);
  assert.match(commit.tree?.sha, HEX40);
  const tree = await github('/git/trees/' + commit.tree.sha + '?recursive=1');
  assert.equal(tree.truncated, false, 'Git tree enumeration truncated');
  assert.equal(tree.sha, commit.tree.sha);
  const output = recordFor(event, run, workflow, tree, jobs.jobs, artifacts.artifacts);
  fs.writeFileSync(recordFile, output.recordBytes, { flag: 'wx' });
  fs.writeFileSync(indexFile, output.indexBytes, { flag: 'wx' });
  fs.writeFileSync(outputFile, JSON.stringify({
    record: output.recordPath, index: output.indexPath }) + '\n', { flag: 'wx' });
}
function selfTest() {
  const sha = 'a'.repeat(40), sourceTree = 'b'.repeat(40), commitTree = 'c'.repeat(40);
  const run = { id: 120, run_attempt: 2, workflow_id: 5,
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    path: '.github/workflows/e2e.yml', event: 'push', head_branch: 'staging',
    head_sha: sha, head_commit: { id: sha }, status: 'completed', conclusion: 'success',
    created_at: '2026-10-10T01:00:00Z' };
  const event = { repository: { full_name: REPO }, workflow_run: {
    id: 120, run_attempt: 2, head_sha: sha, event: 'push' } };
  const workflow = { id: 5, path: '.github/workflows/e2e.yml' };
  const tree = { sha: commitTree, tree: [{ type: 'tree',
    path: 'e2e/tests/browser', sha: sourceTree }] };
  const jobs = [{ name: 'e2e', run_id: 120, id: 66,
    status: 'completed', conclusion: 'success' }];
  const artifacts = [{ id: 33, name: 'playwright-report', size_in_bytes: 1024,
    digest: 'sha256:' + 'd'.repeat(64), expires_at: '2026-10-17T01:00:00Z',
    expired: false }];
  const result = recordFor(event, run, workflow, tree, jobs, artifacts);
  assert.match(result.recordPath, /^runs\/2026-10-10\/120-2\/test\/playwright.json$/);
  assert.ok(result.indexPath.includes('/test/120-2-playwright.json'));
  const record = JSON.parse(result.recordBytes);
  assert.equal(record.evaluation, null);
  assert.equal(record.evidence.sha256, 'd'.repeat(64));
  assert.equal(JSON.parse(result.indexBytes).record_sha256, sha256(result.recordBytes));
  assert.deepEqual(recordFor(event, run, workflow, tree, jobs, artifacts), result);
  for (const [ev, r, wf, tr, js, as] of [
    [{...event, workflow_run:{...event.workflow_run, id:121}},run,workflow,tree,jobs,artifacts],
    [event,{...run,event:'pull_request'},workflow,tree,jobs,artifacts],
    [event,{...run,head_branch:'feature'},workflow,tree,jobs,artifacts],
    [event,run,{...workflow,id:10},tree,jobs,artifacts],
    [event,run,workflow,{...tree,tree:[]},jobs,artifacts],
    [event,run,workflow,tree,[{...jobs[0],conclusion:'failure'}],artifacts],
    [event,run,workflow,tree,jobs,[{...artifacts[0],digest:'sha256:bad'}]],
    [event,run,workflow,tree,jobs,[{...artifacts[0],expired:true}]],
  ]) assert.throws(() => recordFor(ev,r,wf,tr,js,as));
  console.log('trusted E2E Test Run Ingest: immutable SHA/tree, GitHub source, artifact digest and 8 negative fixtures passed');
}
if (process.argv[2] === 'self-test') selfTest();
else if (process.argv[2] === 'create') {
  if (process.argv.length !== 7) throw new Error('create EVENT RECORD INDEX PATHS');
  create(...process.argv.slice(3)).catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: node scripts/e2e-test-run-ingest.mjs self-test|create EVENT RECORD INDEX PATHS'); process.exitCode = 2; }
