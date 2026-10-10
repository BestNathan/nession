#!/usr/bin/env node
'use strict';

// Main-owned privileged ingestion. Never execute, import, source, or eval Task code.
// The upstream workflow and artifact are untrusted observations; authenticated
// source SHA and snapshot are recomputed from a separate exact-SHA checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
function invalid(reason) { throw new Error('Task ingest rejected: ' + reason); }
function readJson(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) invalid('invalid input size or type: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function verify(event, record, snapshot) {
  const run = event.workflow_run;
  if (!run || !event.repository || !run.head_repository) invalid('incomplete GitHub event');
  if (event.repository.full_name !== 'BestNathan/nession' ||
      run.head_repository.full_name !== 'BestNathan/nession' ||
      run.name !== 'Ephemeral Task Runner' ||
      !String(run.path || '').includes('.github/workflows/task-runner.yml')) {
    invalid('wrong repository, workflow or origin');
  }
  if (!Number.isSafeInteger(run.id) || run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) invalid('invalid workflow identity');
  if (run.event === 'push') {
    if (run.head_branch !== 'task/' + record.task_id ||
        run.head_sha !== record.source_sha) invalid('push branch/source SHA mismatch');
  } else if (run.event === 'workflow_dispatch') {
    if (run.head_branch !== 'main') invalid('manual dispatch must use trusted main workflow');
  } else invalid('unsupported workflow event');

  if (record.schema_version !== 1 ||
      !ID.test(record.task_id || '') || !SHA.test(record.source_sha || '') ||
      !/^[0-9a-f]{64}$/.test(record.source_digest || '') ||
      record.run_id !== String(run.id) ||
      record.run_attempt !== run.run_attempt ||
      !['Success','Failed'].includes(record.status) ||
      !Number.isFinite(Date.parse(record.started_at)) ||
      !Number.isFinite(Date.parse(record.finished_at)) ||
      record.source_sha !== snapshot.source_sha ||
      record.task_id !== snapshot.task_id ||
      record.source_digest !== snapshot.source_digest) {
    invalid('reported Task record does not match exact source or run');
  }
  if (typeof record.entry !== 'string' || record.entry.length > 200 ||
      !Array.isArray(snapshot.files) || snapshot.files.length > 32) invalid('invalid Task entry/source snapshot');
  const manifestFile = snapshot.files.find((f) => f.path === 'task.json');
  if (!manifestFile) invalid('Task source snapshot has no manifest');
  const manifest = JSON.parse(Buffer.from(manifestFile.base64, 'base64').toString('utf8'));
  if (manifest.entry !== record.entry || manifest.id !== record.task_id) invalid('entry differs from trusted source');
  if (run.conclusion !== (record.status === 'Success' ? 'success' : 'failure')) {
    invalid('Task status must agree with the completed upstream workflow');
  }
  // This proves source identity, not the semantics of an untrusted script's result.
  return {
    schema_version: 1, trust: 'untrusted-task-observation',
    provenance: 'github-workflow-run-and-independent-exact-source',
    task_id: record.task_id, source_sha: record.source_sha,
    source_digest: record.source_digest, entry: record.entry,
    workflow: { id: run.id, attempt: run.run_attempt, url: run.html_url,
      event: run.event, branch: run.head_branch, conclusion: run.conclusion },
    execution: { status: record.status, exit_code: record.exit_code,
      started_at: record.started_at, finished_at: record.finished_at, result: record.result },
    acceptance_result: null,
  };
}
function put(store, relative, value) {
  if (!/^(runs|sources|indexes)\//.test(relative) ||
      relative.includes('..') || relative.startsWith('/')) invalid('unsafe result path');
  const file = path.join(store, relative);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(bytes)) {
      invalid('append-only result collision at ' + relative);
    }
  } else fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function ingest(eventPath, sourceRoot, incomingPath, resultsRoot) {
  const event = readJson(eventPath, 1024 * 1024);
  const record = readJson(incomingPath, 131072);
  if (!SHA.test(record.source_sha || '') || !ID.test(record.task_id || '')) invalid('invalid source selector');
  // Refuse evidence from a Task branch which altered its inherited workflow.
  // It is still untrusted observation; this binds the expected execution router.
  const workflowRel = path.join('.github', 'workflows', 'task-runner.yml');
  const trustedWorkflow = fs.readFileSync(path.resolve(__dirname, '..', workflowRel));
  const sourceWorkflow = fs.readFileSync(path.resolve(sourceRoot, workflowRel));
  if (!sourceWorkflow.equals(trustedWorkflow)) invalid('Task branch workflow differs from trusted main');

  const snapshot = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, 'task-runner.mjs'), 'inspect', sourceRoot,
    record.source_sha, record.task_id,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  const canonical = verify(event, record, snapshot);
  const id = record.task_id, sha = record.source_sha;
  const key = String(event.workflow_run.id) + '-' + String(event.workflow_run.run_attempt);
  const recordPath = 'runs/' + id + '/' + key + '/record.json';
  const sourcePath = 'sources/' + sha + '/' + id + '.json';
  const indexPath = 'indexes/by-sha/' + sha + '/' + key + '.json';
  canonical.source_snapshot_path = sourcePath;
  put(resultsRoot, sourcePath, snapshot);
  put(resultsRoot, recordPath, canonical);
  put(resultsRoot, indexPath, { task_id: id, source_sha: sha,
    run_id: event.workflow_run.id, run_attempt: event.workflow_run.run_attempt,
    record_path: recordPath, source_path: sourcePath });
  console.log(JSON.stringify({ task_id: id, sha, record: recordPath, snapshot: sourcePath }));
}
function selfTest() {
  const fake = { repository: { full_name: 'BestNathan/nession' }, workflow_run: {
    id: 123, run_attempt: 1, name: 'Ephemeral Task Runner',
    path: '.github/workflows/task-runner.yml',
    event: 'push', head_branch: 'task/test-task', head_sha: 'a'.repeat(40),
    head_repository: { full_name: 'BestNathan/nession' }, conclusion: 'success',
    html_url: 'https://github.com/BestNathan/nession/actions/runs/123',
  }};
  const record = { schema_version: 1, task_id: 'test-task', source_sha: 'a'.repeat(40),
    source_digest: 'b'.repeat(64), entry: 'run.mjs', run_id: '123', run_attempt: 1,
    status: 'Success', started_at: new Date(0).toISOString(),
    finished_at: new Date(1000).toISOString(), exit_code: 0, result: {} };
  const snap = { source_sha: record.source_sha, task_id: record.task_id,
    source_digest: record.source_digest, files: [
      { path: 'task.json', base64: Buffer.from(JSON.stringify({
        id: 'test-task', entry: 'run.mjs' })).toString('base64') },
  ] };
  assert.equal(verify(fake, record, snap).acceptance_result, null);
  assert.throws(() => verify(fake, { ...record, source_sha: 'c'.repeat(40) }, snap), /mismatch/);
  assert.throws(() => verify(fake, { ...record, status: 'Failed' }, snap), /status/);
  assert.throws(() => verify({ ...fake, workflow_run: { ...fake.workflow_run,
    head_branch: 'task/other' } }, record, snap), /branch/);
  assert.throws(() => verify({ ...fake, workflow_run: { ...fake.workflow_run,
    head_repository: { full_name: 'attacker/nession' } } }, record, snap), /origin/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-results-ingest-'));
  try {
    put(dir, 'runs/test-task/123-1/record.json', record);
    put(dir, 'runs/test-task/123-1/record.json', record);
    assert.throws(() => put(dir, 'runs/test-task/123-1/record.json', { ...record, status: 'Failed' }), /collision/);
    assert.throws(() => put(dir, '../escape', record), /unsafe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('Task result ingest positive and negative self-tests passed');
}
function main(argv) {
  if (argv[0] === 'self-test') return selfTest();
  if (argv[0] === 'ingest' && argv.length === 5) {
    return ingest(...argv.slice(1).map((p) => path.resolve(p)));
  }
  invalid('usage: task-result-ingest.mjs self-test|ingest EVENT_JSON SOURCE_ROOT RECORD_JSON STORE');
}
try { main(process.argv.slice(2)); } catch (error) { console.error(error.stack); process.exitCode = 2; }
