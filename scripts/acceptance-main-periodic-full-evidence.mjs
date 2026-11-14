#!/usr/bin/env node
// Trusted read-only proof that an already-merged Main change was followed by a
// REAL scheduled Full Regression, not merely an admission-only green Run.
// This is distinct from exact-SHA Full verification for product regressions.
import assert from 'node:assert/strict';
import { attestFullRegression } from './verification-full-regression-evidence.mjs';

const REPO = 'BestNathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const PATH = '.github/workflows/e2e-full-regression.yml';
const ADMIT_STEP = 'Validate configurable Main Full interval';
const JSON_PREFIX = '{"interval_hours":';

export function shouldCollectMainPeriodicFull(stage, issue) {
  if (stage !== 'post-merge') return false;
  const criteria = String(issue?.body ?? '').match(/### Success Criteria\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  return /\bFull Regression uses a configurable periodic Main admission\b/.test(criteria) &&
    /\bnot an automatic run on every Main push\b/.test(criteria);
}

export function attestScheduledAdmission(run, jobs, log) {
  if (run?.event !== 'schedule' || run?.head_branch !== 'main' ||
      run?.path !== PATH || run?.repository?.full_name !== REPO ||
      run?.head_repository?.full_name !== REPO ||
      !SHA.test(run?.head_sha ?? '') || run?.status !== 'completed' ||
      run?.conclusion !== 'success' || !Number.isSafeInteger(run?.id) ||
      run.id <= 0 || !Number.isSafeInteger(run?.run_attempt) ||
      run.run_attempt <= 0 || !Array.isArray(jobs) || jobs.length > 100 ||
      typeof log !== 'string' || log.length > 4 * 1024 * 1024) {
    throw Error('untrusted scheduled Main Full admission source');
  }
  const admission = jobs.filter(job => job.name === 'admit');
  if (admission.length !== 1) throw Error('missing/ambiguous real admission job');
  const job = admission[0];
  if (!Number.isSafeInteger(job.id) || job.id <= 0 ||
      job.run_id !== run.id || job.run_attempt !== run.run_attempt ||
      job.head_sha !== run.head_sha || job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      job.steps?.filter(s => s.name === ADMIT_STEP &&
        s.status === 'completed' && s.conclusion === 'success').length !== 1) {
    throw Error('scheduled Main Full admission job/step unproven');
  }
  const lines = log.split(/\r?\n/).filter(s => s.includes(JSON_PREFIX));
  if (lines.length !== 1) throw Error('missing/ambiguous periodic admission decision');
  const raw = lines[0].slice(lines[0].indexOf(JSON_PREFIX));
  let decision;
  try { decision = JSON.parse(raw); }
  catch { throw Error('invalid periodic admission JSON'); }
  if (decision?.run !== true || decision?.decision !== 'ELIGIBLE' ||
      !['INTERVAL_ELAPSED','NO_SCHEDULED_FULL_HISTORY'].includes(decision.reason) ||
      !Number.isSafeInteger(decision.interval_hours) ||
      decision.interval_hours < 1 || decision.interval_hours > 168 ||
      !Number.isFinite(Date.parse(decision.next_due_at ?? '')) ||
      (decision.reason === 'INTERVAL_ELAPSED' &&
        (!Number.isFinite(Date.parse(decision.last_full_completed_at ?? '')) ||
         Date.parse(decision.next_due_at) <= Date.parse(decision.last_full_completed_at)))) {
    throw Error('scheduled Full job did not have a validated eligible cadence decision');
  }
  return {admission_job_id:job.id, interval_hours:decision.interval_hours,
    decision:decision.decision, reason:decision.reason,
    last_full_completed_at:decision.last_full_completed_at ?? null,
    next_due_at:decision.next_due_at};
}

export async function collectMainPeriodicFull({
  repo = REPO, anchorSha, get, getText, isAncestor,
  maxPages = 5, pageSize = 20,
}) {
  if (repo !== REPO || !SHA.test(anchorSha ?? '') ||
      typeof get !== 'function' || typeof getText !== 'function' ||
      typeof isAncestor !== 'function' || !Number.isInteger(maxPages) ||
      maxPages < 1 || maxPages > 5 || !Number.isInteger(pageSize) ||
      pageSize < 1 || pageSize > 20) throw Error('invalid Main periodic Full evidence scope');
  const observations = [];
  for (let page = 1; page <= maxPages && observations.length < 2; page++) {
    const q = new URLSearchParams({
      branch:'main',per_page:String(pageSize),page:String(page),
    });
    const response = await get('/repos/' + repo +
      '/actions/workflows/e2e-full-regression.yml/runs?' + q);
    if (!Array.isArray(response?.workflow_runs) ||
        response.workflow_runs.length > pageSize)
      throw Error('unbounded scheduled Full source history');
    for (const run of response.workflow_runs) {
      if (run?.event !== 'schedule' || run?.status !== 'completed' ||
          run?.conclusion !== 'success' || !SHA.test(run?.head_sha ?? '') ||
          run.head_branch !== 'main' || run.path !== PATH ||
          run.repository?.full_name !== REPO ||
          run.head_repository?.full_name !== REPO ||
          !Number.isSafeInteger(run.id) || run.id <= 0 ||
          !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0 ||
          !isAncestor(anchorSha,run.head_sha)) continue;
      const responseJobs = await get('/repos/' + repo + '/actions/runs/' +
        run.id + '/attempts/' + run.run_attempt + '/jobs?per_page=100');
      if (!Array.isArray(responseJobs?.jobs) ||
          responseJobs.jobs.length > 100) throw Error('unbounded scheduled Full jobs');
      const matches = responseJobs.jobs.filter(j => j.name === 'full');
      if (matches.length !== 1 || matches[0].status !== 'completed' ||
          matches[0].conclusion !== 'success' ||
          !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) continue;
      const full = matches[0];
      const fullLog = await getText('/repos/' + repo + '/actions/jobs/' +
        full.id + '/logs',8*1024*1024);
      let verified;
      try {
        verified = attestFullRegression({
          targetSha:run.head_sha,run,job:full,log:fullLog,
        });
      } catch { continue; } // A green workflow alone must never become Full proof.
      const admit = responseJobs.jobs.find(j => j.name === 'admit');
      if (!admit || !Number.isSafeInteger(admit.id) || admit.id <= 0) continue;
      const admitLog = await getText('/repos/' + repo + '/actions/jobs/' +
        admit.id + '/logs',4*1024*1024);
      let admission;
      try { admission = attestScheduledAdmission(run,responseJobs.jobs,admitLog); }
      catch { continue; }
      observations.push({
        kind:'verified_main_periodic_full_observation',
        acceptance_anchor_sha:anchorSha,
        observed_main_sha:run.head_sha,
        source_run_id:run.id,run_attempt:run.run_attempt,
        source_event:'schedule',
        verified_git_ancestry:'original merged source is ancestor of observed Main SHA',
        ...admission,full:verified,
      });
      if (observations.length >= 2) break;
    }
    if (response.workflow_runs.length < pageSize) break;
  }
  return observations;
}

export async function selfTestMainPeriodicFull() {
  const anchor = 'a'.repeat(40), sha = 'b'.repeat(40), repo = REPO;
  const run = {
    id:11,run_attempt:1,event:'schedule',name:'Full Regression main@'+sha,
    path:PATH,head_sha:sha,head_branch:'main',status:'completed',
    conclusion:'success',repository:{full_name:repo},head_repository:{full_name:repo},
  };
  const admit = {id:21,name:'admit',run_id:11,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',steps:[
      {name:ADMIT_STEP,status:'completed',conclusion:'success'},
    ]};
  const full = {id:22,name:'full',run_id:11,run_attempt:1,head_sha:sha,
    status:'completed',conclusion:'success',steps:[
      'Resolve immutable branch/SHA target',
      'Run full canonical Playwright suite at pinned SHA',
      'Verify complete per-ID assertions',
    ].map(name=>({name,status:'completed',conclusion:'success'}))};
  const receipt = {schema_version:1,kind:'e2e_full_per_id',status:'Pass',sha,
    run_id:11,run_attempt:1,catalog_digest:'c'.repeat(64),id_count:1,
    tests:2,assertions:5,results:[{id:'terminal-attach',result:'Pass',
      discovered:2,passed:2,failed:0,skipped:0,flaky:0,assertions:5}]};
  const fullLog = 'E2E_FULL_PER_ID_V1 '+JSON.stringify(receipt)+'\n';
  const decision = {interval_hours:12,last_full_completed_at:'2026-11-13T15:52:18.000Z',
    next_due_at:'2026-11-14T03:52:18.000Z',run:true,decision:'ELIGIBLE',
    reason:'INTERVAL_ELAPSED'};
  const admitLog = '2026-11-14T09:22:00.015Z '+JSON.stringify(decision)+'\n';
  const mock = ({runs=[run],jobs=[admit,full],admitText=admitLog,
    fullText=fullLog,ancestry=true}={})=>({
    repo,anchorSha:anchor,isAncestor:()=>ancestry,
    get:async(path)=>{
      if(path.includes('/actions/workflows/'))return {workflow_runs:runs};
      if(path.includes('/attempts/1/jobs?'))return {jobs};
      throw Error('unexpected GitHub read: '+path);
    },
    getText:async(path)=>path.includes('/jobs/21/')?admitText:fullText,
  });
  const proof = await collectMainPeriodicFull(mock());
  assert.equal(proof.length,1);
  assert.equal(proof[0].acceptance_anchor_sha,anchor);
  assert.equal(proof[0].observed_main_sha,sha);
  assert.equal(proof[0].decision,'ELIGIBLE');
  assert.equal(proof[0].full.id_count,1);
  for(const opts of [
    {ancestry:false},{runs:[{...run,event:'push'}]},
    {runs:[{...run,head_branch:'staging'}]},
    {jobs:[{...admit,conclusion:'skipped'},full]},
    {jobs:[admit,{...full,conclusion:'skipped'}]},
    {admitText:admitLog.replace('"run":true','"run":false')},
    {admitText:admitLog.replace('"decision":"ELIGIBLE"','"decision":"NOT_DUE"')},
    {fullText:fullLog.replace('"status":"Pass"','"status":"Fail"')},
  ]) assert.deepEqual(await collectMainPeriodicFull(mock(opts)),[]);
  assert.equal(shouldCollectMainPeriodicFull('post-merge',{body:
    '### Success Criteria\n- [ ] SC-03 Full Regression uses a configurable periodic Main admission, not an automatic run on every Main push.\n\n## Acceptance Plan'}),true);
  assert.equal(shouldCollectMainPeriodicFull('pr',{body:
    '### Success Criteria\n- [ ] SC-03 Full Regression uses a configurable periodic Main admission, not an automatic run on every Main push.'}),false);
  await assert.rejects(()=>collectMainPeriodicFull({...mock(),anchorSha:'main'}));
  console.log('Main periodic Full: exact scheduled admission, descendant ancestry, all-ID Full and negative source controls passed');
}

if (process.argv[2] === 'self-test') await selfTestMainPeriodicFull();
