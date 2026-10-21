#!/usr/bin/env node
// Main-controlled, append-only metadata-only ingestion for *push* E2E / Tests.
// PR runs (often synthetic merge refs) are intentionally excluded until their
// precise checked-out SHA can be independently attested.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRunIndex } from './run-record-index-contract.mjs';
import { collectScopeArtifact } from './e2e-push-scope-artifact.mjs';
import { attestFullReceipt } from '../e2e/runner/e2e-full-per-id-receipt.mjs';
import {
  parseE2eSelectedRunLog, attestE2eSelectedRunReceipt,
  parseE2eNotRequiredLog, attestE2eNotRequiredReceipt,
  makeE2eSelectedRunReceipt, makeE2eNotRequiredReceipt,
  E2E_SELECTED_RUN_LOG_PREFIX, E2E_NOT_REQUIRED_LOG_PREFIX,
} from './e2e-selected-run-receipt.mjs';

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
  assert.equal(workflow.path, '.github/workflows/e2e-tests.yml');
  assert.equal(run.path, '.github/workflows/e2e-tests.yml');
  assert.equal(run.event, 'push', 'untrusted PR/dispatch source is not an eligible Test Run');
  assert.ok(['staging','main'].includes(run.head_branch), 'untrusted source branch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.match(run.head_sha, HEX40);
  assert.ok(positive(run.id) && positive(run.run_attempt) && positive(run.workflow_id));
  assert.ok(Number.isFinite(Date.parse(run.created_at)));
  assert.equal(run.head_commit?.id, run.head_sha);
}
// GitHub Action artifacts are indexed by Run, NOT by Attempt. A valid exact-SHA
// rerun leaves the failed attempt's "playwright-report" alongside the new
// success artifact with an identical name. Authenticate the exact Attempt's
// completed producer Job first, then select by its GitHub-issued clock window.
// Do not use array order, "newest artifact", or mutable logs as authority.
function requireArtifact(raw, run, job, expectedName = 'playwright-report') {
  assert.equal(raw.name, expectedName);
  assert.ok(positive(raw.id) && positive(raw.size_in_bytes));
  assert.ok(raw.size_in_bytes <= 1024 * 1024 * 1024, 'oversized artifact');
  assert.equal(raw.expired, false, 'artifact already expired');
  assert.match(raw.digest, /^sha256:[a-f0-9]{64}$/, 'artifact digest not verified');
  assert.equal(raw.workflow_run?.id, run.id, 'foreign artifact run');
  assert.equal(raw.workflow_run?.head_sha, run.head_sha, 'foreign artifact SHA');
  const created = Date.parse(raw.created_at);
  assert.ok(Number.isFinite(created), 'artifact creation timestamp required');
  assert.ok(created >= Date.parse(job.started_at) &&
    created <= Date.parse(job.completed_at),
    'artifact was not created during exact successful producer Attempt');
  assert.ok(Number.isFinite(Date.parse(raw.expires_at)));
  assert.ok(Date.parse(raw.expires_at) > created);
  return { artifact_id: raw.id, name: raw.name, size_bytes: raw.size_in_bytes,
    sha256: raw.digest.slice(7), expires_at: raw.expires_at,
    durability: 'GitHub Actions artifact; time-limited, not indefinitely archived' };
}
function requireJob(jobs, run) {
  const matches = jobs.filter(j => j.name === 'e2e' && j.run_id === run.id);
  assert.equal(matches.length, 1, 'missing or duplicate exact E2E job');
  const job = matches[0];
  assert.ok(positive(job.id));
  assert.equal(job.run_attempt, run.run_attempt, 'foreign E2E Attempt');
  assert.equal(job.head_sha, run.head_sha, 'foreign E2E Job SHA');
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  const start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) &&
    start >= Date.parse(run.created_at) && end >= start,
    'invalid exact Attempt producer Job time interval');
  return job;
}
// Scope comes from the authenticated exact-run job, never from the fact a
// push workflow succeeded. A missing receipt must not become "Full Pass".
export function attestPushScope(run,job,log) {
  assert.equal(run.event,'push');
  assert.ok(['main','staging'].includes(run.head_branch));
  assert.ok(typeof log==='string'&&log.length>0&&log.length<8*1024*1024);
  const selected=parseE2eSelectedRunLog(log);
  const noE2e=parseE2eNotRequiredLog(log);
  assert.ok(Number(!!selected)+Number(!!noE2e)<=1,
    'ambiguous post-merge selected/not-required source receipt');
  if(!selected && !noE2e) {
    // Compatibility for already-running historical full main-push Attempts.
    // These must carry their own *real* all-ID receipt, not merely success.
    const lines=log.split(/\r?\n/).filter(line=>line.includes('E2E_FULL_PER_ID_V1 '));
    if(lines.length!==1)throw Error('missing bounded selected/not-required/real-full receipt');
    const full=JSON.parse(lines[0].slice(lines[0].indexOf('E2E_FULL_PER_ID_V1 ')+19));
    return {scope:'full-legacy',receipt:attestFullReceipt(full,run,job)};
  }
  if(selected){
    const verified=attestE2eSelectedRunReceipt(selected,run,job);
    for(const stepName of ['Resolve merged-SHA Issue-selected E2E obligations',
      'Normalize selected per-file results even on failure',
      'Enforce authenticated selected-E2E execution result']) {
      const steps=job.steps?.filter(step=>step.name===stepName)??[];
      assert.equal(steps.length,1,'missing merge selected verification step');
      assert.equal(steps[0].conclusion,'success','selected E2E not verified');
    }
    return {scope:'selected',receipt:verified};
  }
  const verified=attestE2eNotRequiredReceipt(noE2e,run,job);
  const selectedStep=job.steps?.filter(step=>
    step.name==='Resolve merged-SHA Issue-selected E2E obligations')??[];
  assert.equal(selectedStep.length,1);
  assert.equal(selectedStep[0].conclusion,'success');
  return {scope:'not-required',receipt:verified};
}
async function githubJobLog(id){
  const token=process.env.GH_TOKEN??process.env.GITHUB_TOKEN;
  const response=await fetch('https://api.github.com/repos/BestNathan/nession/actions/jobs/'+id+'/logs',{
    headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,
      'User-Agent':'nession-trusted-e2e-scope'},
    signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('GitHub exact-attempt E2E log unavailable: '+response.status);
  const text=await response.text();
  if(text.length>8*1024*1024)throw Error('E2E producer log too large');
  return text;
}
function recordFor(event, run, workflow, tree, jobs, artifacts, scopeProof = null, scopedAssertion = null) {
  assertSource(event, run, workflow);
  assert.match(tree.sha, HEX40);
  const sourceTree = tree.tree.find(x => x.path === 'e2e/tests/browser' && x.type === 'tree');
  assert.ok(sourceTree && HEX40.test(sourceTree.sha), 'missing authentic Playwright source tree');
  const job = requireJob(jobs, run);
  const found = artifacts.filter(x => x.name === 'playwright-report' &&
    Number.isFinite(Date.parse(x.created_at)) &&
    Date.parse(x.created_at) >= Date.parse(job.started_at) &&
    Date.parse(x.created_at) <= Date.parse(job.completed_at));
  if(scopeProof?.scope!=='not-required')
    assert.equal(found.length, 1, 'missing or ambiguous exact-Attempt report artifact');
  const requiredName=scopeProof?.scope==='not-required'?'issue-e2e-verification':'playwright-report';
  const required=artifacts.filter(x=>x.name===requiredName &&
    Number.isFinite(Date.parse(x.created_at))&&
    Date.parse(x.created_at)>=Date.parse(job.started_at)&&
    Date.parse(x.created_at)<=Date.parse(job.completed_at));
  assert.equal(required.length,1,'missing or ambiguous scoped source artifact');
  const artifact = requireArtifact(required[0], run, job, requiredName);
  let selectedE2eArtifact=null;
  if(scopeProof?.scope==='selected') {
    const matches=artifacts.filter(a=>a.name==='issue-e2e-verification' &&
      Number.isFinite(Date.parse(a.created_at)) &&
      Date.parse(a.created_at)>=Date.parse(job.started_at) &&
      Date.parse(a.created_at)<=Date.parse(job.completed_at));
    assert.equal(matches.length,1,'missing/ambiguous authenticated selected E2E artifact');
    selectedE2eArtifact=requireArtifact(matches[0],run,job,'issue-e2e-verification');
  }
  const proof = { job_id: job.id, name: job.name, conclusion: job.conclusion,
    run_attempt: job.run_attempt };
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
    test_scope: scopeProof?.scope??'historical-unclassified',
    test_scope_receipt: scopeProof?.receipt??null,
    test_scope_assertion: scopedAssertion,
    selected_e2e_artifact: selectedE2eArtifact,
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
    github('/actions/workflows/e2e-tests.yml'),
    github('/actions/runs/' + id + '/attempts/' + event.workflow_run.run_attempt +
      '/jobs?per_page=100'),
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
  const exactJob=requireJob(jobs.jobs,run);
  const scopeProof=attestPushScope(run,exactJob,await githubJobLog(exactJob.id));
  const preliminary=recordFor(event, run, workflow, tree, jobs.jobs, artifacts.artifacts,scopeProof);
  const provisional=JSON.parse(preliminary.recordBytes);
  const scopedAssertion=scopeProof.scope==='selected'||scopeProof.scope==='not-required'
    ?await collectScopeArtifact({run,scopeProof,
      artifact:provisional.selected_e2e_artifact??provisional.evidence,
      token:process.env.GH_TOKEN??process.env.GITHUB_TOKEN})
    :null;
  const output = scopedAssertion
    ? recordFor(event,run,workflow,tree,jobs.jobs,artifacts.artifacts,scopeProof,scopedAssertion)
    : preliminary;
  fs.writeFileSync(recordFile, output.recordBytes, { flag: 'wx' });
  fs.writeFileSync(indexFile, output.indexBytes, { flag: 'wx' });
  fs.writeFileSync(outputFile, JSON.stringify({
    record: output.recordPath, index: output.indexPath }) + '\n', { flag: 'wx' });
}
function selfTest() {
  const sha = 'a'.repeat(40), sourceTree = 'b'.repeat(40), commitTree = 'c'.repeat(40);
  const run = { id: 120, run_attempt: 2, workflow_id: 5,
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
    name: 'E2E / Tests', path: '.github/workflows/e2e-tests.yml', event: 'push', head_branch: 'staging',
    head_sha: sha, head_commit: { id: sha }, status: 'completed', conclusion: 'success',
    created_at: '2026-10-10T01:00:00Z' };
  const event = { repository: { full_name: REPO }, workflow_run: {
    id: 120, run_attempt: 2, head_sha: sha, event: 'push' } };
  const workflow = { id: 5, path: '.github/workflows/e2e-tests.yml' };
  const tree = { sha: commitTree, tree: [{ type: 'tree',
    path: 'e2e/tests/browser', sha: sourceTree }] };
  const jobs = [{ name: 'e2e', run_id: 120, run_attempt: 2, id: 66,
    head_sha: sha, started_at: '2026-10-10T01:01:00Z',
    completed_at: '2026-10-10T01:10:00Z',
    status: 'completed', conclusion: 'success' }];
  const artifacts = [{ id: 33, name: 'playwright-report', size_in_bytes: 1024,
    digest: 'sha256:' + 'd'.repeat(64), expires_at: '2026-10-17T01:00:00Z',
    created_at: '2026-10-10T01:09:00Z',
    workflow_run: { id: 120, head_sha: sha }, expired: false }];
  const result = recordFor(event, run, workflow, tree, jobs, artifacts);
  assert.match(result.recordPath, /^runs\/2026-10-10\/120-2\/test\/playwright.json$/);
  assert.ok(result.indexPath.includes('/test/120-2-playwright.json'));
  const record = JSON.parse(result.recordBytes);
  assert.equal(record.evaluation, null);
  assert.equal(record.evidence.sha256, 'd'.repeat(64));
  assert.equal(JSON.parse(result.indexBytes).record_sha256, sha256(result.recordBytes));
  assert.deepEqual(recordFor(event, run, workflow, tree, jobs, artifacts), result);
  // A push "success" alone is not Full E2E: authenticate the exact
  // selected/not-required result and its mandatory step outcomes.
  const env={GITHUB_REPOSITORY:REPO,GITHUB_RUN_ID:'120',GITHUB_RUN_ATTEMPT:'2'};
  const sr=makeE2eSelectedRunReceipt({env,sha,selectedIds:['terminal-attach'],provisions:1});
  const scopedJob={...jobs[0],steps:[
    {name:'Run E2E tests',conclusion:'success'},
    {name:'Resolve merged-SHA Issue-selected E2E obligations',conclusion:'success'},
    {name:'Normalize selected per-file results even on failure',conclusion:'success'},
    {name:'Enforce authenticated selected-E2E execution result',conclusion:'success'},
  ]};
  const selectedProof=attestPushScope(run,scopedJob,
    E2E_SELECTED_RUN_LOG_PREFIX+JSON.stringify(sr)+'\n');
  assert.equal(selectedProof.scope,'selected');
  const selectedArtifact={...artifacts[0],id:35,name:'issue-e2e-verification'};
  const scopedRecord=JSON.parse(recordFor(event,run,workflow,tree,[scopedJob],
    [...artifacts,selectedArtifact],selectedProof).recordBytes);
  assert.equal(scopedRecord.test_scope,'selected');
  assert.equal(scopedRecord.selected_e2e_artifact.artifact_id,35);
  assert.throws(()=>recordFor(event,run,workflow,tree,[scopedJob],artifacts,selectedProof),
    /missing\/ambiguous/);
  const nr=makeE2eNotRequiredReceipt({env,sha,steps:{
    rust_toolchain:'skipped',cargo_build:'skipped',tmux:'skipped',design_gate:'success',
  }});
  const nrJob={...jobs[0],steps:[
    {name:'Resolve merged-SHA Issue-selected E2E obligations',conclusion:'success'},
    {name:'Run E2E tests',conclusion:'success'},
    {name:'Install Rust toolchain',conclusion:'skipped'},
    {name:'Build Rust binaries',conclusion:'skipped'},
    {name:'Install tmux',conclusion:'skipped'},
    {name:'Run canonical browser design gate (standalone)',conclusion:'success'},
  ]};
  const notRequiredProof=attestPushScope(run,nrJob,
    E2E_NOT_REQUIRED_LOG_PREFIX+JSON.stringify(nr)+'\n');
  assert.equal(notRequiredProof.scope,'not-required');
  const nrRecord=JSON.parse(recordFor(event,run,workflow,tree,[nrJob],
    [selectedArtifact],notRequiredProof).recordBytes);
  assert.equal(nrRecord.test_scope,'not-required');
  assert.throws(()=>attestPushScope(run,scopedJob,'untrusted full push'),/receipt/);
  assert.throws(()=>attestPushScope(run,scopedJob,
    E2E_SELECTED_RUN_LOG_PREFIX+JSON.stringify(sr)+'\n'+
    E2E_NOT_REQUIRED_LOG_PREFIX+JSON.stringify(nr)+'\n'),/ambiguous/);

  // Real GitHub Actions rerun semantics: the failed Attempt's same-name
  // artifact remains listed by Run. It must NEVER invalidate the new successful
  // Attempt, nor can newest/first ordering substitute for identity checks.
  const staleArtifact = { ...artifacts[0], id: 31,
    created_at: '2026-10-10T01:00:30Z' };
  const currentWithStale = [staleArtifact, ...artifacts];
  assert.deepEqual(recordFor(event, run, workflow, tree, jobs, currentWithStale), result);
  assert.deepEqual(recordFor(event, run, workflow, tree, jobs, [...currentWithStale].reverse()), result);
  for (const invalid of [
    [event, run, workflow, tree, jobs, [staleArtifact]],
    [event, run, workflow, tree, jobs, [...artifacts, { ...artifacts[0], id: 34 }]],
    [event, run, workflow, tree, [{ ...jobs[0], run_attempt: 1 }], artifacts],
    [event, run, workflow, tree, [{ ...jobs[0], head_sha: 'f'.repeat(40) }], artifacts],
    [event, run, workflow, tree, jobs,
      [{ ...artifacts[0], workflow_run: { id: 120, head_sha: 'f'.repeat(40) } }]],
    [event, run, workflow, tree, jobs,
      [{ ...artifacts[0], workflow_run: { id: 121, head_sha: sha } }]],
    [event, run, workflow, tree, jobs,
      [{ ...artifacts[0], created_at: '2026-10-10T01:10:01Z' }]],
  ]) assert.throws(() => recordFor(...invalid));
  // These are additional negatives over the original eight.

  // Producer/consumer reachability is part of the security contract: a green
  // PR-only E2E is NOT real post-merge main Push Test evidence.
  const sourceWorkflowYml=fs.readFileSync(new URL('../.github/workflows/e2e-tests.yml',import.meta.url),'utf8');
  const ingesterWorkflowYml=fs.readFileSync(new URL('../.github/workflows/e2e-test-ingest.yml',import.meta.url),'utf8');
  assert.match(sourceWorkflowYml,/^  push:\n    branches: \[staging, main\]$/m,
    'main push must run real E2E and produce its own trusted source SHA');
  assert.match(ingesterWorkflowYml,/github\.event\.workflow_run\.event == 'push'/,
    'Test Ingest must reject PR/dispatch-only sources');
  assert.match(ingesterWorkflowYml,/github\.event\.workflow_run\.head_branch == 'main'/,
    'main successful push Test Ingest must be reachable');
  const mainRun={...run,head_branch:'main'};
  const mainRecord=recordFor(event,mainRun,workflow,tree,jobs,artifacts);
  assert.equal(JSON.parse(mainRecord.recordBytes).source.head_branch,'main');

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
  console.log('trusted E2E Test Run Ingest: immutable SHA/tree, exact run-attempt job/artifact provenance, GitHub digest and 15 negative fixtures passed');
}
if (process.argv[2] === 'self-test') selfTest();
else if (process.argv[2] === 'create') {
  if (process.argv.length !== 7) throw new Error('create EVENT RECORD INDEX PATHS');
  create(...process.argv.slice(3)).catch(e => { console.error(e.message); process.exitCode = 1; });
} else { console.error('usage: node scripts/e2e-test-run-ingest.mjs self-test|create EVENT RECORD INDEX PATHS'); process.exitCode = 2; }
