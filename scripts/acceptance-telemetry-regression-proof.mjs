#!/usr/bin/env node
// Read-only, GitHub+Git authenticated evidence of normal workflow regressions.
// Immutable GitHub jobs are mandatory; Issue SC text pins IDs for lookup only.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession', SHA=/^[a-f0-9]{40}$/;
const DAYS=7*24*60*60*1000;
const SPECS=Object.freeze([
  ['provider','Agent / Provider Smoke','agent-provider-smoke.yml','push',
    [['Read-only Acceptance (cursor)',['Invoke real Provider using production Acceptance entrypoint']]]],
  ['sc_acceptance','Agent / SC Acceptance','agent-sc-acceptance.yml','workflow_dispatch',
    [['Execute acceptance',['Run read-only Acceptance Agent','Upload structured Acceptance Result']],
     ['Deterministic Issue updater',['Apply Acceptance Report and checkbox projection']]]],
  ['issue_audit','Agent / Issue Audit','agent-issue-audit.yml','issues',
    [['contract',['Audit deterministic Issue Contract']],['agent',['Audit and repair issue']]]],
  ['orchestrator','Acceptance / Orchestrator','acceptance-orchestrator.yml','workflow_run',
    [['reconcile-completed-quality-e2e',['Converge only when both source workflows and Issue evidence are current']]]],
  ['repository_metrics','Metrics / Repository Health','metrics-repository.yml','schedule',
    [['rust-health',['Collect Rust health']],['web-health',['Collect Web health']],
     ['e2e-health',['Collect E2E health']],
     ['publish',['Generate repository metrics','Generate Agent workflow metrics','Publish durable metrics branch']]]],
  ['quality_gate','CI / Quality Gate','ci-quality.yml','push',
    [['rust-check',['Verify Rust and Acceptance Gates']],
     ['web-check',['Verify negative fixtures and Acceptance harness contracts']]]],
]);
function fail(message){throw Error('main workflow regression proof: '+message);}
export function regressionPins(body){
  const section=String(body??'').match(/###? Success Criteria\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]??'';
  const rows=section.split('\n').filter(l=>/^- \[[ x]\] SC-05\b/.test(l)&&
    l.includes('Historical workflow regression discovery constraint:'));
  if(rows.length===0)return null;
  if(rows.length!==1)fail('duplicate regression discovery');
  const patterns={
    provider:/Provider Run ([1-9]\d*)/,
    sc_acceptance:/SC Acceptance Run ([1-9]\d*)/,
    issue_audit:/Issue Audit Run ([1-9]\d*)/,
    orchestrator:/Orchestrator Run ([1-9]\d*)/,
    repository_metrics:/Scheduled Repository Metrics Run ([1-9]\d*)/,
    quality_gate:/Quality Gate Run ([1-9]\d*)/,
  };
  const pins={};
  for(const [name,pattern] of Object.entries(patterns)){
    const m=rows[0].match(pattern);
    if(!m)fail('missing '+name+' discovery ID');
    const id=Number(m[1]);
    if(!Number.isSafeInteger(id)||id<=0)fail('invalid regression discovery ID');
    pins[name]=id;
  }
  if(new Set(Object.values(pins)).size!==SPECS.length)
    fail('duplicate regression run ID');
  return pins;
}
export function attestRegressions(pins,observed,ancestry,now=Date.now()){
  if(!pins||!Array.isArray(observed)||observed.length!==SPECS.length||
     !Array.isArray(ancestry)||ancestry.length!==SPECS.length)
    fail('incomplete independently authenticated regression inputs');
  const successes=[];
  for(let i=0;i<SPECS.length;i++){
    const [key,name,file,event,required]=SPECS[i];
    const {run,jobs}=observed[i]??{};
    const created=Date.parse(run?.created_at??'');
    if(run?.id!==pins[key]||run?.name!==name||
       run?.path!=='.github/workflows/'+file||run?.event!==event||
       run?.head_branch!=='main'||!SHA.test(run?.head_sha??'')||
       run?.repository?.full_name!==REPO||
       run?.head_repository?.full_name!==REPO||
       run?.status!=='completed'||run?.conclusion!=='success'||
       !Number.isSafeInteger(run?.run_attempt)||run.run_attempt<1||
       !Number.isFinite(created)||created<now-DAYS||created>now+300000||
       ancestry[i]!==true)
      fail('untrusted/stale/non-ancestral regression source '+key);
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
      fail('incomplete workflow job results '+key);
    const validated=[];
    for(const [jobName,stepNames] of required){
      const matches=jobs.jobs.filter(job=>job.name===jobName);
      if(matches.length!==1)fail('missing/duplicate required job '+jobName);
      const job=matches[0];
      if(job.run_id!==run.id||job.run_attempt!==run.run_attempt||
         job.status!=='completed'||job.conclusion!=='success'||
         !Number.isSafeInteger(job.id)||job.id<1||
         !Array.isArray(job.steps)||job.steps.length>100)
        fail('incomplete authenticated job '+jobName);
      for(const stepName of stepNames){
        const steps=job.steps.filter(s=>s.name===stepName);
        if(steps.length!==1||steps[0].status!=='completed'||
           steps[0].conclusion!=='success')
          fail('required regression step did not pass: '+stepName);
      }
      validated.push({job_id:job.id,name:jobName,verified_steps:stepNames});
    }
    successes.push({workflow:key,run_id:run.id,run_attempt:run.run_attempt,
      source_sha:run.head_sha,event:run.event,created_at:run.created_at,
      jobs:validated,git_ancestor:true});
  }
  return {kind:'verified_main_workflow_regressions',window_days:7,
    evidence:'independent GitHub exact Run/Attempt/jobs/required steps and Git merge-base ancestry',
    results:successes,skipped_or_empty_not_counted:true};
}
export async function collectWorkflowRegressions({repo,issue,stage,targetSha,workspace,
  request,checkAncestor}){
  if(stage!=='post-merge'||Number(issue?.number)!==1749)return null;
  if(repo!==REPO||!SHA.test(targetSha))fail('bad acceptance scope');
  const pins=regressionPins(issue.body);
  if(!pins)return null;
  const observed=await Promise.all(SPECS.map(async([key])=>{
    const run=await request('/repos/'+repo+'/actions/runs/'+pins[key]);
    if(!Number.isSafeInteger(run?.run_attempt)||run.run_attempt<1)
      fail('invalid source attempt');
    const jobs=await request('/repos/'+repo+'/actions/runs/'+pins[key]+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    return {run,jobs};
  }));
  const ancestry=observed.map(({run})=>
    SHA.test(run?.head_sha??'')&&
    checkAncestor(workspace,targetSha,run.head_sha).is_ancestor===true);
  return attestRegressions(pins,observed,ancestry);
}
export function selfTestRegressions(){
  const section='### Success Criteria\n- [ ] SC-05 Historical workflow regression discovery constraint: Provider Run 301; SC Acceptance Run 302; Issue Audit Run 303; Orchestrator Run 304; Scheduled Repository Metrics Run 305; Quality Gate Run 306.\n\n## Acceptance Report';
  const pins=regressionPins(section);
  assert.deepEqual(Object.values(pins),[301,302,303,304,305,306]);
  assert.equal(regressionPins('### Success Criteria\n- [ ] SC-04 none'),null);
  assert.throws(()=>regressionPins(section.replace('Quality Gate Run','Missing Run')),/missing/);
  const now=Date.parse('2026-10-18T12:00:00Z');
  const repo={full_name:REPO};
  const observed=SPECS.map(([key,name,file,event,required],i)=>{
    const id=pins[key];
    const sha='a'.repeat(40);
    return {run:{id,name,path:'.github/workflows/'+file,event,
      head_branch:'main',head_sha:sha,repository:repo,head_repository:repo,
      status:'completed',conclusion:'success',run_attempt:1,
      created_at:'2026-10-17T12:00:00Z'},
      jobs:{jobs:required.map(([jobName,stepNames],index)=>({
        id:400+i*10+index,run_id:id,run_attempt:1,name:jobName,
        status:'completed',conclusion:'success',
        steps:stepNames.map(step=>({name:step,status:'completed',conclusion:'success'})),
      }))}};
  });
  const ancestry=Array(SPECS.length).fill(true);
  const attest=(o=observed,a=ancestry,at=now)=>attestRegressions(pins,o,a,at);
  assert.equal(attest().results.length,6);
  assert.throws(()=>attest(observed,[false,...ancestry.slice(1)]),/ancestral/);
  assert.throws(()=>attest(observed.map((x,i)=>i===0?
    {...x,run:{...x.run,event:'pull_request'}}:x)),/untrusted/);
  assert.throws(()=>attest(observed.map((x,i)=>i===0?
    {...x,run:{...x.run,created_at:'2026-09-01T00:00:00Z'}}:x)),/stale/);
  assert.throws(()=>attest(observed.map((x,i)=>i===4?
    {...x,jobs:{jobs:x.jobs.jobs.map(j=>j.name==='publish'?
      {...j,steps:j.steps.map(s=>s.name==='Publish durable metrics branch'?
        {...s,conclusion:'skipped'}:s)}:j)}}:x)),/did not pass/);
  assert.throws(()=>attest(observed.map((x,i)=>i===2?
    {...x,jobs:{jobs:x.jobs.jobs.map(j=>j.name==='agent'?
      {...j,conclusion:'skipped'}:j)}}:x)),/incomplete authenticated/);
  console.log('normal workflows regression: six true main run/job/step provenance and negative fixtures passed');
}
