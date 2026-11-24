#!/usr/bin/env node
// #4137/#4059: independent, operation-level attestation for workflow-bearing
// staging integration. A green Controller or Waker is never a write receipt.
import assert from 'node:assert/strict';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const WORKFLOW='.github/workflows/release-staging-convergence.yml';
const REQUIRED=['CI / Quality Gate','E2E / Tests','Acceptance / Case Smoke'];
const ALLOWED_EVENTS=new Set(['push','workflow_run','schedule','issues']);

function logDocuments(log) {
  if(typeof log!=='string'||log.length>2_000_000)return [];
  const lines=log.split(/\r?\n/).map(x=>x
    .replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z /,'')
    .replace(/\u001b\[[0-9;]*m/g,''));
  const out=[];
  for(let i=0;i<lines.length;i++){
    const head=lines[i].trim();
    if(head!=='{'&&head!=='[')continue;
    let depth=0,quoted=false,escape=false,buffer='';
    for(let j=i;j<Math.min(i+180,lines.length);j++){
      const line=lines[j];
      buffer+=(j===i?'':'\n')+line;
      for(const ch of line){
        if(escape){escape=false;continue;}
        if(ch==='\\'&&quoted){escape=true;continue;}
        if(ch==='"'){quoted=!quoted;continue;}
        if(!quoted&&(ch==='{'||ch==='['))depth++;
        if(!quoted&&(ch==='}'||ch===']'))depth--;
      }
      if(depth<0||buffer.length>128_000)break;
      if(depth===0){
        try {out.push(JSON.parse(buffer));}catch{/* non-JSON log is not proof */}
        i=j;
        break;
      }
    }
  }
  return out;
}
export function convergenceLogReceipt(log) {
  const docs=logDocuments(log);
  const plans=docs.filter(x=>x?.schema_version===1&&SHA.test(x.main_sha??'')&&
    Array.isArray(x.branches));
  const results=docs.filter(x=>Array.isArray(x)&&x.some(y=>y?.direction));
  if(plans.length!==1||results.length!==1)return null;
  return {plan:plans[0],results:results[0]};
}

const jobStep=(job,name)=>Array.isArray(job?.steps)&&
  job.steps.some(x=>x.name===name&&x.conclusion==='success'&&x.status==='completed');

export function attestConvergenceWriter({repo,targetSha,run,job,log,pr,commit,
  ciRuns,stagingComparison}={}) {
  if(repo!==REPO||!SHA.test(targetSha??'')||
     !Number.isSafeInteger(run?.id)||run.id<=0||
     !Number.isSafeInteger(run?.run_attempt)||run.run_attempt<=0||
     run.path!==WORKFLOW||run.name!=='Release / Staging Convergence'||
     !ALLOWED_EVENTS.has(run.event)||run.head_branch!=='main'||
     run.head_sha!==targetSha||run.status!=='completed'||run.conclusion!=='success'||
     job?.name!=='converge'||job.status!=='completed'||job.conclusion!=='success'||
     !Number.isSafeInteger(job.id)||job.id<=0||
     !jobStep(job,'Mint workflow-file integration token from Publisher App')||
     !jobStep(job,'Idempotently prepare and arm protected GitHub Auto-merge'))
    return null;

  const transcript=convergenceLogReceipt(log);
  if(!transcript||transcript.plan.main_sha!==targetSha)return null;
  const branches=transcript.plan.branches.filter(b=>b.branch==='staging'&&
    SHA.test(b.sha??'')&&b.workflow_write_required===true&&
    Array.isArray(b.actions)&&b.actions.includes('sync-main-to-lane'));
  if(branches.length!==1)return null;
  const lane=branches[0];
  const results=transcript.results.filter(row=>row.branch==='staging'&&
    row.direction==='sync-main-to-lane'&&
    (row.outcome==='AUTO_MERGE_QUALIFIED'||row.outcome==='MERGED')&&
    (row.action==='created'||row.action==='reused')&&
    !row.reason&&Number.isSafeInteger(row.number)&&row.number>0&&
    SHA.test(row.integration_head??''));
  if(results.length!==1)return null;
  const result=results[0];

  // A successful App mint alone is insufficient: require the exact
  // two-parent integration commit, protected PR merge and source HEAD CI.
  if(pr?.number!==result.number||pr?.user?.login!=='nession-publisher[bot]'||
     pr?.base?.ref!=='staging'||pr.base?.repo?.full_name!==repo||
     pr?.head?.repo?.full_name!==repo||pr.head.sha!==result.integration_head||
     pr?.head?.ref?.startsWith('chore/staging-sync-')!==true||
     !pr?.body?.startsWith('Staging Convergence automated proposal')||
     !pr?.merged_at||pr?.state!=='closed'||!SHA.test(pr.merge_commit_sha??'')||
     commit?.sha!==result.integration_head||
     commit.parents?.length!==2||
     commit.parents[0]?.sha!==lane.sha||commit.parents[1]?.sha!==targetSha||
     stagingComparison?.merge_base_commit?.sha!==pr.merge_commit_sha||
     !['ahead','identical'].includes(stagingComparison?.status))
    return null;
  if(!Array.isArray(ciRuns)||ciRuns.length>100)return null;
  const checks=[];
  for(const name of REQUIRED){
    const matches=ciRuns.filter(x=>x.name===name&&x.head_sha===result.integration_head&&
      x.event==='pull_request'&&x.status==='completed'&&x.conclusion==='success'&&
      Array.isArray(x.pull_requests)&&x.pull_requests.some(y=>y.number===pr.number)&&
      Number.isSafeInteger(x.id)&&x.id>0&&
      Number.isSafeInteger(x.run_attempt)&&x.run_attempt>0);
    if(matches.length===0)return null;
    checks.push({name,run_id:matches[0].id,run_attempt:matches[0].run_attempt});
  }
  return {kind:'authenticated_convergence_writer_v1',status:'verified',
    target_sha:targetSha,source_run_id:run.id,source_run_attempt:run.run_attempt,
    source_job_id:job.id,source_main_sha:targetSha,lane_sha:lane.sha,
    writer_mint:'success',controller_outcome:result.outcome,
    integration_pr:pr.number,integration_head:result.integration_head,
    protected_merge_sha:pr.merge_commit_sha,ci_checks:checks};
}

export function validConvergenceWriterReceipt(proof,targetSha) {
  return proof?.kind==='authenticated_convergence_writer_v1'&&
    proof.status==='verified'&&SHA.test(targetSha??'')&&
    proof.target_sha===targetSha&&proof.source_main_sha===targetSha&&
    Number.isSafeInteger(proof.source_run_id)&&proof.source_run_id>0&&
    Number.isSafeInteger(proof.source_run_attempt)&&proof.source_run_attempt>0&&
    Number.isSafeInteger(proof.source_job_id)&&proof.source_job_id>0&&
    proof.writer_mint==='success'&&
    ['AUTO_MERGE_QUALIFIED','MERGED'].includes(proof.controller_outcome)&&
    Number.isSafeInteger(proof.integration_pr)&&proof.integration_pr>0&&
    SHA.test(proof.integration_head??'')&&SHA.test(proof.lane_sha??'')&&
    SHA.test(proof.protected_merge_sha??'')&&
    Array.isArray(proof.ci_checks)&&proof.ci_checks.length===REQUIRED.length&&
    REQUIRED.every(name=>proof.ci_checks.some(x=>x.name===name&&
      Number.isSafeInteger(x.run_id)&&x.run_id>0&&
      Number.isSafeInteger(x.run_attempt)&&x.run_attempt>0));
}

// The Acceptor's prose cannot confer writer authority. A source-bound Pass
// without the independent collector's operation receipt stays Pending.
export function enforceConvergenceWriter4059(context,normalized) {
  if(context?.issue?.number!==4059||context?.stage!=='post-merge')
    return normalized;
  const proof=context?.ci_evidence?.authenticated_convergence_writer_4059;
  const valid=validConvergenceWriterReceipt(proof,context.target_ref);
  const items=(normalized?.criteria??[]).map(item=>{
    if(item.criterion!=='SC-02'||item.result!=='Pass')return item;
    if(!valid)return {...item,result:'Pending',evidence:[],
      summary:'Workflow writer authorization is unproven: no exact-source '+
        'successful App writer mint, non-BLOCKED Controller outcome, '+
        'two-parent PR, exact-HEAD CI and protected merge readback'};
    return {...item,summary:'Independently attested workflow-bearing staging '+
      'promotion and protected merge',
      evidence:[{type:'authenticated-convergence-writer',value:
        'Run '+proof.source_run_id+'/'+proof.source_run_attempt+
        ', converge Job '+proof.source_job_id+
        ', App writer minted, '+proof.controller_outcome+
        ', Draft/integration PR #'+proof.integration_pr+
        ', head '+proof.integration_head+
        ', protected merge '+proof.protected_merge_sha+
        ', exact-HEAD Quality/Case/E2E verified'}]};
  });
  return {...normalized,criteria:items,
    ...(valid?{authenticated_convergence_writer_4059:proof}:{})};
}

// Independently enforce the same receipt shape in the deterministic Issue
// writer. The model or downloaded result cannot inject a green-only verdict.
export function mayProjectConvergenceWriter4059(result) {
  if(result?.issue!==4059||result?.stage!=='post-merge'||
     !result?.criteria?.some(x=>x.criterion==='SC-02'&&x.result==='Pass'))
    return true;
  return validConvergenceWriterReceipt(
    result.authenticated_convergence_writer_4059,result.target_ref);
}

// #4137 lifecycle repair: the historically disproven #4059 SC-02 Pass cited a
// green Post-Run Waker (Run 44678335169) and a BLOCKED/MERGE_CONFLICT converge
// job (Run 44678377431) whose workflow-file writer mint was skipped. Those exact
// sources are immutable history, never acceptance. This deterministic,
// source-bound invalidation lets the lifecycle owner refuse closure and
// re-select the negative source for a trusted replay even though the old row is
// still checked Pass. It never rewrites the row; new results remain governed by
// enforceConvergenceWriter4059 / mayProjectConvergenceWriter4059 above.
const DISPROVEN_4059_SC02_RUNS=Object.freeze([44678335169,44678377431]);
export function invalidatedConvergenceWriter4059Row(issueNumber,criterion,evidence) {
  if(issueNumber!==4059||criterion!=='SC-02')return false;
  const text=String(evidence??'');
  return DISPROVEN_4059_SC02_RUNS.some(id=>
    new RegExp('(?:^|[^0-9])'+id+'(?:[^0-9]|$)').test(text));
}

// This routine makes read-only source-bound REST observations. The source Run
// is only a lookup candidate; authorization comes from independent Run, Step,
// structured Controller result, PR ancestry, CI and protected merge witnesses.
export async function collectConvergenceWriter4059({repo,targetSha,runs,get,getLog}={}) {
  if(repo!==REPO||!SHA.test(targetSha??'')||!Array.isArray(runs)||
    typeof get!=='function'||typeof getLog!=='function')return null;
  const choices=runs.filter(r=>r.path===WORKFLOW&&r.name==='Release / Staging Convergence'&&
    ALLOWED_EVENTS.has(r.event)&&r.head_sha===targetSha&&r.head_branch==='main'&&
    r.status==='completed'&&r.conclusion==='success').slice(0,12);
  for(const run of choices){
    const jobs=await get('/repos/'+repo+'/actions/runs/'+run.id+
      '/attempts/'+run.run_attempt+'/jobs?per_page=100');
    if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>=100)continue;
    const candidates=jobs.jobs.filter(x=>x.name==='converge'&&x.conclusion==='success');
    if(candidates.length!==1)continue;
    const job=candidates[0];
    if(!jobStep(job,'Mint workflow-file integration token from Publisher App')||
       !jobStep(job,'Idempotently prepare and arm protected GitHub Auto-merge'))continue;
    const log=await getLog('/repos/'+repo+'/actions/jobs/'+job.id+'/logs');
    const t=convergenceLogReceipt(log);
    const row=t?.results?.find(x=>x.direction==='sync-main-to-lane'&&
      Number.isSafeInteger(x.number)&&x.number>0&&SHA.test(x.integration_head??''));
    if(!row)continue;
    const [pr,commit,ci,stage]=await Promise.all([
      get('/repos/'+repo+'/pulls/'+row.number),
      get('/repos/'+repo+'/git/commits/'+row.integration_head),
      get('/repos/'+repo+'/actions/runs?head_sha='+row.integration_head+'&per_page=100'),
      get('/repos/'+repo+'/branches/staging')
    ]);
    if(!SHA.test(pr?.merge_commit_sha??'')||!SHA.test(stage?.commit?.sha??''))continue;
    const compare=await get('/repos/'+repo+'/compare/'+pr.merge_commit_sha+
      '...'+stage.commit.sha);
    const proof=attestConvergenceWriter({repo,targetSha,run,job,log,pr,commit,
      ciRuns:ci?.workflow_runs,stagingComparison:compare});
    if(validConvergenceWriterReceipt(proof,targetSha))return proof;
  }
  return null;
}

export function selfTestConvergenceWriter4137() {
  const sha='a'.repeat(40),lane='b'.repeat(40),head='c'.repeat(40),merge='d'.repeat(40);
  const run={id:111,run_attempt:1,path:WORKFLOW,name:'Release / Staging Convergence',
    head_branch:'main',head_sha:sha,event:'push',status:'completed',conclusion:'success'};
  const job={id:222,name:'converge',status:'completed',conclusion:'success',steps:[
    {name:'Mint workflow-file integration token from Publisher App',status:'completed',conclusion:'success'},
    {name:'Idempotently prepare and arm protected GitHub Auto-merge',status:'completed',conclusion:'success'}
  ]};
  const plan={schema_version:1,main_sha:sha,branches:[{branch:'staging',sha:lane,
    workflow_write_required:true,actions:['sync-main-to-lane']}]};
  const decisions=[{branch:'staging',direction:'sync-main-to-lane',action:'created',
    number:333,integration_head:head,outcome:'AUTO_MERGE_QUALIFIED'}];
  const transcript=[JSON.stringify(plan,null,2),JSON.stringify(decisions,null,2)]
    .join('\n').split('\n').map(x=>'2026-11-23T07:00:00.001Z '+x).join('\n');
  const pr={number:333,state:'closed',merged_at:'2026-11-23T07:30:00Z',
    merge_commit_sha:merge,user:{login:'nession-publisher[bot]'},
    base:{ref:'staging',repo:{full_name:REPO}},
    head:{ref:'chore/staging-sync-fixture',sha:head,repo:{full_name:REPO}},
    body:'Staging Convergence automated proposal (fixture)'};
  const commit={sha:head,parents:[{sha:lane},{sha}]};
  const ciRuns=REQUIRED.map((name,i)=>({id:400+i,run_attempt:1,name,
    head_sha:head,event:'pull_request',status:'completed',conclusion:'success',
    pull_requests:[{number:333}]}));
  const valid={repo:REPO,targetSha:sha,run,job,log:transcript,pr,commit,ciRuns,
    stagingComparison:{status:'ahead',merge_base_commit:{sha:merge}}};
  const good=attestConvergenceWriter(valid);
  assert.equal(validConvergenceWriterReceipt(good,sha),true);

  const context={issue:{number:4059},stage:'post-merge',target_ref:sha,
    ci_evidence:{authenticated_convergence_writer_4059:good}};
  const claimed={criteria:[{criterion:'SC-02',result:'Pass',
    evidence:[{type:'workflow',value:'unrelated green Waker'}],summary:'green job'}]};
  const evidence=enforceConvergenceWriter4059(context,claimed);
  assert.equal(evidence.criteria[0].result,'Pass');
  assert.match(evidence.criteria[0].evidence[0].value,/App writer minted/);
  assert.doesNotMatch(evidence.criteria[0].summary,/green job/);
  for(const untrusted of [
    null,{...good,target_sha:'f'.repeat(40)},
    {...good,controller_outcome:'BLOCKED'},
    {...good,writer_mint:'skipped'}, {...good,ci_checks:[]}
  ]) {
    const denied=enforceConvergenceWriter4059({...context,
      ci_evidence:{authenticated_convergence_writer_4059:untrusted}},claimed);
    assert.equal(denied.criteria[0].result,'Pending');
    assert.deepEqual(denied.criteria[0].evidence,[]);
    assert.equal('authenticated_convergence_writer_4059' in denied,false);
  }
  assert.equal(enforceConvergenceWriter4059({...context,issue:{number:4140}},
    claimed).criteria[0].result,'Pass','other Issues unchanged');
  assert.equal(mayProjectConvergenceWriter4059({
    issue:4059,stage:'post-merge',target_ref:sha,criteria:evidence.criteria,
    authenticated_convergence_writer_4059:good}),true);
  assert.equal(mayProjectConvergenceWriter4059({
    issue:4059,stage:'post-merge',target_ref:sha,criteria:evidence.criteria}),false);
  assert.equal(mayProjectConvergenceWriter4059({
    issue:4059,stage:'post-merge',target_ref:'f'.repeat(40),
    criteria:evidence.criteria,authenticated_convergence_writer_4059:good}),false);
  assert.equal(mayProjectConvergenceWriter4059({
    issue:4059,stage:'post-merge',target_ref:sha,
    criteria:[{criterion:'SC-02',result:'Pending'}]}),true);

  assert.equal(enforceConvergenceWriter4059(context,{criteria:[{
    criterion:'SC-02',result:'Fail',evidence:[],summary:'observed denial'
  }]}).criteria[0].result,'Fail','real failures remain failures');

  for(const mutation of [
    {job:{...job,steps:job.steps.map(s=>s.name.startsWith('Mint')?
      {...s,conclusion:'skipped'}:s)}},
    {job:{...job,steps:job.steps.map(s=>s.name.startsWith('Mint')?
      {...s,conclusion:'failure'}:s)}}, // GitHub App HTTP 422
    {run:{...run,name:'Acceptance / Post-Run Waker'}},
    {run:{...run,head_sha:'f'.repeat(40)}},
    {run:{...run,path:'.github/workflows/acceptance-postrun-waker.yml'}},
    {run:{...run,event:'pull_request_target'}},
    {pr:{...pr,state:'open',merged_at:null}},
    {commit:{...commit,parents:[{sha:lane},{sha:'f'.repeat(40)}]}},
    {ciRuns:ciRuns.map(x=>({...x,pull_requests:[{number:334}]}))},
    {stagingComparison:{status:'diverged',merge_base_commit:{sha:merge}}},
    {log:transcript.replace('AUTO_MERGE_QUALIFIED','BLOCKED')},
    {log:transcript.replace('"workflow_write_required": true','"workflow_write_required": false')},
    {log:transcript.replace('"direction": "sync-main-to-lane"','"direction": "promote-lane-to-main"')},
    {log:transcript+'\n'+JSON.stringify(decisions,null,2).split('\n')
      .map(x=>'2026-11-23T07:00:00.001Z '+x).join('\n')},
  ])assert.equal(attestConvergenceWriter({...valid,...mutation}),null,
    'unsafe Controller/Writer/PR/check/provenance evidence must fail closed');
  assert.equal(validConvergenceWriterReceipt(good,'e'.repeat(40)),false);
  assert.equal(convergenceLogReceipt('unstructured green workflow'),null);
  assert.equal(convergenceLogReceipt('2026-11-23T07:00:00.001Z [\n' +
    '2026-11-23T07:00:00.001Z broken'),null);
  // #4137 lifecycle invalidation is keyed to the exact disproven sources only.
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-02',
    'run 44678335169; ref f24451c94f700d9c25ddb061873854889ed4b36e; source agent-qwen; '+
    'workflow: Convergence run 44678377431 conclusion=success'),true);
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-02',
    'run 45332410930; ref '+sha+'; source agent-qwen; authenticated-convergence-writer: '+
    'Run 111/1, App writer minted, MERGED'),false,'a genuine receipt is not invalidated');
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-02','run 999; ref '+sha),false);
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-01','run 44678335169'),false);
  assert.equal(invalidatedConvergenceWriter4059Row(4140,'SC-02','run 44678335169'),false);
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-02','run 446783351690'),false,
    'a longer run id must not match the disproven source');
  assert.equal(invalidatedConvergenceWriter4059Row(4059,'SC-02',null),false);
  return true;
}
if(process.argv[1]?.endsWith('/acceptance-convergence-writer-4137.mjs')&&
   process.argv[2]==='self-test'){
  selfTestConvergenceWriter4137();
  process.stdout.write('acceptance convergence writer attestation: PASS\n');
}
