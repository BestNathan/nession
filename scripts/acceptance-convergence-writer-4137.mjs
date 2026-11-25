#!/usr/bin/env node
// #4137/#4059: independent, operation-level attestation for workflow-bearing
// staging integration. A green Controller or Waker is never a write receipt.
import assert from 'node:assert/strict';
import {requiredSourceRuns} from './staging-convergence-readiness.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const WORKFLOW='.github/workflows/release-staging-convergence.yml';
const REQUIRED=['CI / Quality Gate','E2E / Tests','Acceptance / Case Smoke'];
const REQUIRED_WORKFLOWS=['ci-quality.yml','e2e-tests.yml','acceptance-case-smoke.yml'];
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
  // Reuse the canonical exact-HEAD source-check policy, including its
  // immutable orphan-association rule for an already-merged native sync PR
  // (#3248: GitHub may empty run.pull_requests after the merge). Never
  // re-implement or weaken that association here.
  const source=requiredSourceRuns(pr.number,result.integration_head,ciRuns,pr);
  if(!source.ready)return null;
  const checks=(source.checks??[]).map(check=>({
    name:check.name,run_id:check.run_id,run_attempt:check.run_attempt}));
  if(checks.length!==REQUIRED.length||
     !REQUIRED.every(name=>checks.some(check=>check.name===name)))
    return null;
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

// #4477 SC-03: the native convergence admission criterion may claim Pass only
// with the same independently collected operation receipt. The Agent's prose
// or a green run conclusion alone is not proof of the sync PR admission.
export function enforceNativeConvergenceAdmission4477(context,normalized) {
  if(context?.issue?.number!==4477||context?.stage!=='post-merge')
    return normalized;
  const proof=context?.ci_evidence?.authenticated_native_convergence_admission;
  const valid=validConvergenceWriterReceipt(proof,context.target_ref);
  const items=(normalized?.criteria??[]).map(item=>{
    if(item.criterion!=='SC-03'||item.result!=='Pass')return item;
    if(!valid)return {...item,result:'Pending',evidence:[],
      summary:'Native convergence admission is unproven: no exact-source '+
        'controller run, sync PR, protected merge and exact-HEAD CI readback'};
    return {...item,summary:'Independently attested native convergence admission',
      evidence:[{type:'authenticated-native-convergence-admission',value:
        'Run '+proof.source_run_id+'/'+proof.source_run_attempt+
        ', converge Job '+proof.source_job_id+', '+proof.controller_outcome+
        ', sync PR #'+proof.integration_pr+', head '+proof.integration_head+
        ', protected merge '+proof.protected_merge_sha+
        ', exact-HEAD Quality/Case/E2E verified'}]};
  });
  return {...normalized,criteria:items,
    ...(valid?{authenticated_native_convergence_admission:proof}:{})};
}

export function mayProjectNativeConvergenceAdmission4477(result) {
  if(result?.issue!==4477||result?.stage!=='post-merge'||
     !result?.criteria?.some(x=>x.criterion==='SC-03'&&x.result==='Pass'))
    return true;
  return validConvergenceWriterReceipt(
    result.authenticated_native_convergence_admission,result.target_ref);
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
  if(repo!==REPO||!SHA.test(targetSha??'')||
    typeof get!=='function'||typeof getLog!=='function')return null;
  // A target Main SHA can have more than 100 unrelated workflow runs, so the
  // caller's bounded direct-run page may not contain this controller run.
  // Ask the convergence workflow itself for its exact-SHA history.
  const workflowRuns=await get('/repos/'+repo+'/actions/workflows/'+
    encodeURIComponent('release-staging-convergence.yml')+
    '/runs?head_sha='+targetSha+'&per_page=100');
  const inventory=[...new Map([
    ...(Array.isArray(runs)?runs:[]),
    ...(Array.isArray(workflowRuns?.workflow_runs)?workflowRuns.workflow_runs:[]),
  ].map(run=>[run.id,run])).values()];
  const choices=inventory.filter(r=>r.path===WORKFLOW&&
    r.name==='Release / Staging Convergence'&&
    ALLOWED_EVENTS.has(r.event)&&r.head_sha===targetSha&&r.head_branch==='main'&&
    r.status==='completed'&&r.conclusion==='success').slice(0,40);
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
    // Fetch each required workflow's exact-HEAD history directly; the general
    // run page is capped and can omit an older merged source's green run.
    const ciPages=await Promise.all(REQUIRED_WORKFLOWS.map(file=>
      get('/repos/'+repo+'/actions/workflows/'+encodeURIComponent(file)+
        '/runs?head_sha='+row.integration_head+'&per_page=100')));
    const ciRuns=[...new Map(ciPages.flatMap(page=>
      Array.isArray(page?.workflow_runs)?page.workflow_runs:[])
      .map(run=>[run.id,run])).values()];
    const [pr,commit,stage]=await Promise.all([
      get('/repos/'+repo+'/pulls/'+row.number),
      get('/repos/'+repo+'/git/commits/'+row.integration_head),
      get('/repos/'+repo+'/branches/staging')
    ]);
    if(!SHA.test(pr?.merge_commit_sha??'')||!SHA.test(stage?.commit?.sha??''))continue;
    const compare=await get('/repos/'+repo+'/compare/'+pr.merge_commit_sha+
      '...'+stage.commit.sha);
    const proof=attestConvergenceWriter({repo,targetSha,run,job,log,pr,commit,
      ciRuns,stagingComparison:compare});
    if(validConvergenceWriterReceipt(proof,targetSha))return proof;
  }
  return null;
}

export async function selfTestConvergenceWriterFetch() {
  const sha='a'.repeat(40),lane='b'.repeat(40),head='c'.repeat(40),merge='d'.repeat(40);
  const stageSha='e'.repeat(40);
  const run={id:111,run_attempt:1,path:WORKFLOW,name:'Release / Staging Convergence',
    head_branch:'main',head_sha:sha,event:'workflow_run',status:'completed',conclusion:'success'};
  const job={id:222,name:'converge',status:'completed',conclusion:'success',steps:[
    {name:'Mint workflow-file integration token from Publisher App',status:'completed',conclusion:'success'},
    {name:'Idempotently prepare and arm protected GitHub Auto-merge',status:'completed',conclusion:'success'}
  ]};
  const plan={schema_version:1,main_sha:sha,branches:[{branch:'staging',sha:lane,
    workflow_write_required:true,actions:['sync-main-to-lane']}]};
  const decisions=[{branch:'staging',direction:'sync-main-to-lane',action:'created',
    number:333,integration_head:head,outcome:'AUTO_MERGE_QUALIFIED'}];
  const transcript=[JSON.stringify(plan,null,2),JSON.stringify(decisions,null,2)]
    .join('\n').split('\n').map(line=>'2026-11-23T07:00:00.001Z '+line).join('\n');
  const pr={number:333,state:'closed',created_at:'2026-11-23T07:00:00Z',
    merged_at:'2026-11-23T07:30:00Z',merge_commit_sha:merge,
    user:{login:'nession-publisher[bot]'},
    base:{ref:'staging',repo:{full_name:REPO}},
    head:{ref:'chore/staging-sync-fixture',sha:head,repo:{full_name:REPO}},
    body:'Staging Convergence automated proposal (fixture)\n\n'+
      '<!-- nession-convergence-pr:v1 branch=staging main='+sha+
      ' lane='+lane+' head='+head+' digest='+'e'.repeat(64)+' -->'};
  const commit={sha:head,parents:[{sha:lane},{sha}]};
  const ciRuns=[
    {name:'CI / Quality Gate',path:'.github/workflows/ci-quality.yml'},
    {name:'E2E / Tests',path:'.github/workflows/e2e-tests.yml'},
    {name:'Acceptance / Case Smoke',path:'.github/workflows/acceptance-case-smoke.yml'},
  ].map((entry,index)=>({id:400+index,run_attempt:1,name:entry.name,
    path:entry.path,head_branch:pr.head.ref,created_at:'2026-11-23T07:10:00Z',
    head_sha:head,event:'pull_request',status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    pull_requests:[]}));
  const get=async path=>{
    if(path.includes('/actions/workflows/release-staging-convergence.yml/runs'))
      return {workflow_runs:[run]};
    if(path.includes('/actions/runs/111/attempts/1/jobs'))return {jobs:[job]};
    if(path.includes('/actions/workflows/ci-quality.yml/runs'))
      return {workflow_runs:[ciRuns[0]]};
    if(path.includes('/actions/workflows/e2e-tests.yml/runs'))
      return {workflow_runs:[ciRuns[1]]};
    if(path.includes('/actions/workflows/acceptance-case-smoke.yml/runs'))
      return {workflow_runs:[ciRuns[2]]};
    if(path.endsWith('/pulls/333'))return pr;
    if(path.endsWith('/git/commits/'+head))return commit;
    if(path.endsWith('/branches/staging'))return {commit:{sha:stageSha}};
    if(path.includes('/compare/'))
      return {status:'ahead',merge_base_commit:{sha:merge}};
    throw new Error('unexpected bounded readback route: '+path);
  };
  const getLog=async path=>{
    if(path.endsWith('/actions/jobs/222/logs'))return transcript;
    throw new Error('unexpected bounded log route: '+path);
  };
  // The target SHA's general run page may be exhausted by unrelated runs; the
  // collector must discover the controller run from its workflow history.
  const proof=await collectConvergenceWriter4059({repo:REPO,targetSha:sha,
    runs:[],get,getLog});
  assert.equal(validConvergenceWriterReceipt(proof,sha),true,
    'workflow-specific convergence history must yield the exact receipt');
  const missing=await collectConvergenceWriter4059({repo:REPO,targetSha:sha,
    runs:[],get:async path=>path.includes(
      '/actions/workflows/release-staging-convergence.yml/runs')
      ?{workflow_runs:[]}:get(path),getLog});
  assert.equal(missing,null,'no controller run is not admission evidence');
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
  const pr={number:333,state:'closed',created_at:'2026-11-23T07:00:00Z',
    merged_at:'2026-11-23T07:30:00Z',
    merge_commit_sha:merge,user:{login:'nession-publisher[bot]'},
    base:{ref:'staging',repo:{full_name:REPO}},
    head:{ref:'chore/staging-sync-fixture',sha:head,repo:{full_name:REPO}},
    body:'Staging Convergence automated proposal (fixture)\n\n'+
      '<!-- nession-convergence-pr:v1 branch=staging main='+sha+
      ' lane='+lane+' head='+head+' digest='+'e'.repeat(64)+' -->'};
  const commit={sha:head,parents:[{sha:lane},{sha}]};
  const workflowPaths={
    'CI / Quality Gate':'.github/workflows/ci-quality.yml',
    'E2E / Tests':'.github/workflows/e2e-tests.yml',
    'Acceptance / Case Smoke':'.github/workflows/acceptance-case-smoke.yml',
  };
  const ciRuns=REQUIRED.map((name,i)=>({id:400+i,run_attempt:1,name,
    path:workflowPaths[name]+'@refs/heads/main',head_branch:pr.head.ref,
    created_at:'2026-11-23T07:10:00Z',
    head_sha:head,event:'pull_request',status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    pull_requests:[{number:333}]}));
  const valid={repo:REPO,targetSha:sha,run,job,log:transcript,pr,commit,ciRuns,
    stagingComparison:{status:'ahead',merge_base_commit:{sha:merge}}};
  const good=attestConvergenceWriter(valid);
  assert.equal(validConvergenceWriterReceipt(good,sha),true);
  // #3248: GitHub may empty run.pull_requests after the native sync PR merges.
  // The canonical exact-HEAD policy accepts only the immutable orphan shape
  // (same source head/branch/repo, created during the PR's lifetime).
  const orphanCiRuns=ciRuns.map(run=>({...run,pull_requests:[]}));
  const orphanGood=attestConvergenceWriter({...valid,ciRuns:orphanCiRuns});
  assert.equal(validConvergenceWriterReceipt(orphanGood,sha),true,
    'a merged native sync PR may use immutable orphan run association');
  assert.equal(attestConvergenceWriter({...valid,ciRuns:orphanCiRuns.map(run=>
    run.name==='E2E / Tests'?{...run,head_branch:'someone-else'}:run)}),null,
    'an orphan run on a different head branch is not this PR');
  assert.equal(attestConvergenceWriter({...valid,ciRuns:orphanCiRuns.map(run=>
    run.name==='E2E / Tests'?{...run,created_at:'2026-11-23T08:00:00Z'}:run)}),null,
    'a run created after the merge is not source evidence');

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

  // #4477 SC-03 uses the same receipt to gate native convergence admission.
  const admissionContext={issue:{number:4477},stage:'post-merge',target_ref:sha,
    ci_evidence:{authenticated_native_convergence_admission:good}};
  const admissionClaim={criteria:[{criterion:'SC-03',result:'Pass',
    evidence:[{type:'workflow',value:'green run'}],summary:'green run'}]};
  const admitted=enforceNativeConvergenceAdmission4477(admissionContext,
    admissionClaim);
  assert.equal(admitted.criteria[0].result,'Pass');
  assert.match(admitted.criteria[0].evidence[0].value,/AUTO_MERGE_QUALIFIED/);
  const deniedAdmission=enforceNativeConvergenceAdmission4477(
    {...admissionContext,ci_evidence:{authenticated_native_convergence_admission:null}},
    admissionClaim);
  assert.equal(deniedAdmission.criteria[0].result,'Pending');
  assert.deepEqual(deniedAdmission.criteria[0].evidence,[]);
  assert.equal(mayProjectNativeConvergenceAdmission4477({issue:4477,
    stage:'post-merge',target_ref:sha,criteria:admitted.criteria,
    authenticated_native_convergence_admission:good}),true);
  assert.equal(mayProjectNativeConvergenceAdmission4477({issue:4477,
    stage:'post-merge',target_ref:sha,criteria:admitted.criteria}),false);
  assert.equal(mayProjectNativeConvergenceAdmission4477({issue:4477,
    stage:'post-merge',target_ref:sha,
    criteria:[{criterion:'SC-03',result:'Pending'}]}),true);

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
