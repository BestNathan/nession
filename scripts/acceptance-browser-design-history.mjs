#!/usr/bin/env node
// #1876: replay *immutable original* Browser Design source-run evidence across
// unrelated PR heads. Pins are discovery hints ONLY; GitHub REST source
// Run/Attempt/Job and original job logs remain authoritative.
// This intentionally does not generalize mutable Issue comments into Passes.
import assert from 'node:assert/strict';

const REPO = 'BestNathan/nession';
const WORKFLOW = '.github/workflows/e2e-tests.yml';
const SHA = /^[a-f0-9]{40}$/;
const EXPECTED_DESIGN_IDS = ['ui-contract-assertions','ui-contract-matrix',
  'ui-contract-web','design-renderer-boundary'];
const NEGATIVES = ['missing-id','skipped','flaky','zero-assertions',
  'foreign-sha','corrupt-report','missing-assertions','mismatched-assertion'];
const SOURCES = Object.freeze([
  { kind: 'not-required', id: 39031997222, sha: '9ab3775e6802dd3db99d3ee9e73c11b3a91e0530',
    event: 'pull_request', pr: 1890, steps: {
      'Install Rust toolchain': 'skipped',
      'Install tmux': 'skipped', 'Build Rust binaries': 'skipped',
      'Run canonical browser design gate (standalone)': 'success',
      'Run E2E tests': 'success',
    } },
  { kind: 'selected', id: 39031366091, sha: '9ea937117f21de87535091991a56916bed7475b9',
    event: 'pull_request', steps: {
      'Run E2E tests': 'success',
      'Verify canonical browser design gate from the single E2E run': 'success',
      'Prove coalesced Browser Design evidence fails closed': 'success',
      'Run canonical browser design gate (standalone)': 'skipped',
    } },
  { kind: 'full', id: 39032685734, sha: '9ea937117f21de87535091991a56916bed7475b9',
    event: 'workflow_dispatch', steps: {
      'Run E2E tests': 'success',
      'Verify canonical browser design gate from the single E2E run': 'success',
      'Prove coalesced Browser Design evidence fails closed': 'success',
      'Run canonical browser design gate (standalone)': 'skipped',
    } },
]);

function singleLine(log, prefix) {
  if (typeof log !== 'string' || log.length > 4_194_304) throw Error('unbounded original log');
  const found = log.split(/\r?\n/).filter(x => x.includes(prefix));
  if (found.length !== 1) throw Error('missing/duplicate authenticated '+prefix+' record');
  const content = found[0].slice(found[0].indexOf(prefix) + prefix.length).trim();
  if (content.length > 16384) throw Error('oversized '+prefix+' record');
  return JSON.parse(content);
}
function requireStep(job, name, conclusion) {
  const steps = job.steps?.filter(s => s.name === name) ?? [];
  assert.equal(steps.length, 1, 'absent/duplicate step: '+name);
  assert.equal(steps[0].status, 'completed', 'incomplete '+name);
  assert.equal(steps[0].conclusion, conclusion, 'wrong step: '+name);
}
export function attestSource(pin, run, jobs, log, pr = null) {
  assert.ok(SOURCES.some(x => x.kind === pin?.kind && x.id === pin?.id &&
    x.sha === pin?.sha), 'unregistered original source');
  assert.ok(SHA.test(pin.sha));
  assert.equal(run?.id, pin.id);
  assert.equal(run?.head_sha, pin.sha);
  assert.equal(run?.run_attempt, 1, 'wrong original source attempt');
  assert.equal(run?.event, pin.event);
  assert.equal(run?.name, 'E2E / Tests');
  assert.equal(run?.path, WORKFLOW);
  assert.equal(run?.repository?.full_name, REPO);
  assert.equal(run?.head_repository?.full_name, REPO);
  assert.equal(run?.status, 'completed');
  assert.equal(run?.conclusion, 'success');
  assert.ok(Array.isArray(jobs?.jobs) && jobs.jobs.length > 0 &&
    jobs.jobs.length <= 100 && jobs.total_count <= 100);
  const found = jobs.jobs.filter(j => j?.name === 'e2e');
  assert.equal(found.length, 1, 'ambiguous original E2E job');
  const job = found[0];
  assert.equal(job.run_id, run.id);
  assert.equal(job.run_attempt, run.run_attempt);
  assert.equal(job.head_sha, run.head_sha);
  assert.equal(job.status, 'completed');
  assert.equal(job.conclusion, 'success');
  for (const [name, outcome] of Object.entries(pin.steps)) requireStep(job, name, outcome);
  if (pin.kind === 'not-required') {
    assert.equal(pr?.number, pin.pr);
    assert.equal(pr?.head?.sha, pin.sha);
    assert.equal(pr?.head?.repo?.full_name, REPO);
    assert.equal(pr?.base?.ref, 'main');
    assert.equal(pr?.merged_at, null, 'explicit-none fixture must not be merged');
  }
  const design = singleLine(log, 'BROWSER_DESIGN_GATE_V1 ');
  assert.equal(design.schema_version, 1);
  assert.equal(design.kind, 'browser_design_gate');
  assert.equal(design.sha, pin.sha);
  assert.equal(design.status, 'Pass');
  assert.match(design.catalog_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual([...design.ids].sort(), [...EXPECTED_DESIGN_IDS].sort());
  assert.ok(Number.isSafeInteger(design.tests) && design.tests >= EXPECTED_DESIGN_IDS.length);
  assert.ok(Number.isSafeInteger(design.assertions) && design.assertions > 0);
  assert.equal(design.results?.length, EXPECTED_DESIGN_IDS.length);
  assert.deepEqual([...design.results.map(x=>x.id)].sort(), [...EXPECTED_DESIGN_IDS].sort());
  assert.equal(design.results.reduce((n,x) => {
    assert.ok(Number.isSafeInteger(x.discovered) && x.discovered > 0);
    assert.equal(x.passed, x.discovered);
    assert.ok(Number.isSafeInteger(x.assertions) && x.assertions > 0);
    return n + x.discovered;
  }, 0), design.tests);
  assert.equal(design.results.reduce((n,x)=>n+x.assertions,0), design.assertions);
  const negatives = singleLine(log, 'BROWSER_DESIGN_FAIL_CLOSED_V1 ');
  assert.equal(negatives.sha, pin.sha);
  assert.equal(negatives.status, 'Pass');
  assert.equal(negatives.negatives, NEGATIVES.length);
  assert.deepEqual([...negatives.rejected].sort(), [...NEGATIVES].sort());
  let none = null;
  if (pin.kind === 'not-required') {
    none = singleLine(log, 'E2E_NOT_REQUIRED_RECEIPT_V1 ');
    assert.equal(none.schema_version, 1);
    assert.equal(none.kind, 'e2e_not_required');
    assert.equal(none.repository, REPO);
    assert.equal(none.workflow, WORKFLOW);
    assert.equal(none.run_id, pin.id);
    assert.equal(none.run_attempt, 1);
    assert.equal(none.sha, pin.sha);
    assert.equal(none.plan_mode, 'not-required');
    assert.deepEqual(none.steps, { rust_toolchain:'skipped', cargo_build:'skipped',
      tmux:'skipped', design_gate:'success' });
  }
  return { kind:pin.kind, run_id:pin.id, run_attempt:1, sha:pin.sha,
    event:pin.event, job_id:job.id,
    design_catalog_digest:design.catalog_digest,
    design_test_ids:design.ids, design_tests:design.tests,
    design_assertions:design.assertions,
    rejected_negatives:negatives.rejected,
    not_required: none ? { mode:none.plan_mode, skipped_rust:true,
      skipped_tmux:true, independently_passed_design:true }:null,
    source:'GitHub original REST run/attempt/job/step + job-log record (re-attested)' };
}
export async function collectHistoricalBrowserDesignProof({
  issueNumber, repo, get, getText,
}) {
  if (issueNumber !== 1876) return null;
  if (repo !== REPO || typeof get !== 'function' || typeof getText !== 'function')
    throw Error('invalid scoped Browser Design proof collector');
  const result = [];
  for (const pin of SOURCES) {
    const [run, jobs, pr] = await Promise.all([
      get('/repos/'+repo+'/actions/runs/'+pin.id),
      get('/repos/'+repo+'/actions/runs/'+pin.id+'/attempts/1/jobs?per_page=100'),
      pin.pr ? get('/repos/'+repo+'/pulls/'+pin.pr) : Promise.resolve(null),
    ]);
    assert.equal(jobs?.total_count <= 100, true, 'truncated original jobs');
    const sourceJobs = jobs.jobs?.filter(j=>j.name === 'e2e') ?? [];
    assert.equal(sourceJobs.length, 1);
    const log = await getText('/repos/'+repo+'/actions/jobs/'+sourceJobs[0].id+'/logs',4194304);
    result.push(attestSource(pin, run, jobs, log, pr));
  }
  return { schema_version:1, kind:'browser_design_historical_regressions',
    issue:1876, not_required:result[0], selected:result[1], full:result[2],
    sc03_verified:result[0].not_required?.independently_passed_design===true,
    sc04_verified:result.every(x=>x.rejected_negatives.length===8) &&
      result[1].sha===result[2].sha };
}
export function selfTestHistoricalBrowserDesign() {
  const src=SOURCES[0], catalog='a'.repeat(64);
  const run={id:src.id,run_attempt:1,head_sha:src.sha,event:src.event,
    name:'E2E / Tests',path:WORKFLOW,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const job={name:'e2e',id:23,run_id:src.id,run_attempt:1,head_sha:src.sha,
    status:'completed',conclusion:'success',
    steps:Object.entries(src.steps).map(([name,conclusion])=>({
      name,conclusion,status:'completed'}))};
  const jobs={total_count:1,jobs:[job]};
  const pr={number:src.pr,head:{sha:src.sha,repo:{full_name:REPO}},
    base:{ref:'main'},merged_at:null};
  const records=EXPECTED_DESIGN_IDS.map(id=>({id,discovered:1,passed:1,assertions:2}));
  const design={schema_version:1,kind:'browser_design_gate',sha:src.sha,
    status:'Pass',catalog_digest:catalog,ids:EXPECTED_DESIGN_IDS,
    results:records,tests:4,assertions:8};
  const neg={status:'Pass',sha:src.sha,rejected:NEGATIVES,negatives:8};
  const none={schema_version:1,kind:'e2e_not_required',repository:REPO,
    workflow:WORKFLOW,run_id:src.id,run_attempt:1,sha:src.sha,
    plan_mode:'not-required',steps:{rust_toolchain:'skipped',cargo_build:'skipped',
      tmux:'skipped',design_gate:'success'}};
  const logOf=(d=design,n=neg,rec=none)=>['BROWSER_DESIGN_GATE_V1 '+JSON.stringify(d),
    'BROWSER_DESIGN_FAIL_CLOSED_V1 '+JSON.stringify(n),
    'E2E_NOT_REQUIRED_RECEIPT_V1 '+JSON.stringify(rec)].join('\n');
  const log=logOf();
  assert.equal(attestSource(src,run,jobs,log,pr).design_tests,4);
  for (const [ru,js,lg,p] of [
    [{...run,head_sha:'b'.repeat(40)},jobs,log,pr],
    [{...run,event:'push'},jobs,log,pr],
    [run,{...jobs,jobs:[{...job,steps:job.steps.slice(1)}]},log,pr],
    [run,jobs,logOf({...design,status:'Pending'}),pr],
    [run,jobs,logOf({...design,sha:'b'.repeat(40)}),pr],
    [run,jobs,logOf({...design,results:records.slice(1)}),pr],
    [run,jobs,logOf(design,{...neg,rejected:NEGATIVES.slice(1)}),pr],
    [run,jobs,logOf(design,neg,{...none,plan_mode:'selected'}),pr],
    [run,jobs,log+'\n'+log,pr],
    [run,jobs,log,{...pr,head:{...pr.head,sha:'b'.repeat(40)}}],
  ]) assert.throws(()=>attestSource(src,ru,js,lg,p));
  console.log('historical Browser Design proof: 10 fail-closed mutations pass');
}
if (process.argv[1]?.endsWith('acceptance-browser-design-history.mjs') &&
    process.argv[2]==='self-test') selfTestHistoricalBrowserDesign();
