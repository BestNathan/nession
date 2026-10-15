#!/usr/bin/env node
// Independent, bounded source-completion receipts for the Bug-only Acceptance
// bootstrap (#1818). Mutable witness text selects candidates, not verdicts.
import assert from 'node:assert/strict';
import path from 'node:path';
import { downloadedResult } from './acceptance-cross-issue-receipt.mjs';

const REPO='BestNathan/nession';
const SHA=/^[0-9a-f]{40}$/;
const ACCEPTANCE_STEPS=[
  'Prepare stage-specific immutable acceptance context',
  'Run read-only Acceptance Agent',
  'Upload structured Acceptance Result',
];
const UPDATER='Apply Acceptance Report and checkbox projection';
function hasSuccess(job,name) {
  const found=job.steps?.filter(s=>s.name===name)??[];
  return found.length===1&&found[0].status==='completed'&&found[0].conclusion==='success';
}

export function pinnedBugBootstrap(body) {
  const section=String(body??'').match(/^## Related Bug Completion Evidence\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]??'';
  const lines=section.split('\n').filter(l=>l.startsWith('Related Bug witness:'));
  if(lines.length>1)throw Error('ambiguous related Bug completion witness');
  if(!lines.length)return null;
  const m=lines[0].match(/^Related Bug witness: Issue #([1-9]\d*); PR #([1-9]\d*) HEAD ([0-9a-f]{40}) MERGE ([0-9a-f]{40}); pre-merge Run ([1-9]\d*) attempt ([1-9]\d*); post-merge Run ([1-9]\d*) attempt ([1-9]\d*); E2E Run ([1-9]\d*) attempt ([1-9]\d*)$/);
  if(!m)throw Error('invalid related Bug completion witness format');
  const nums=[m[1],m[2],m[5],m[6],m[7],m[8],m[9],m[10]].map(Number);
  if(nums.some(n=>!Number.isSafeInteger(n)||n<=0))throw Error('related Bug witness overflow');
  return {issue:nums[0],pr:nums[1],head:m[3],merge:m[4],
    preRun:nums[2],preAttempt:nums[3],postRun:nums[4],postAttempt:nums[5],
    e2eRun:nums[6],e2eAttempt:nums[7]};
}

function verifiedStage(pin,kind,run,jobs,artifact,result) {
  const pre=kind==='pre';
  const runId=pre?pin.preRun:pin.postRun;
  const attempt=pre?pin.preAttempt:pin.postAttempt;
  const target=pre?pin.head:pin.merge;
  const stage=pre?'pre-merge':'post-merge';
  const prefix=pre?'pre-merge-acceptance ('+pin.issue+')':'evaluate ('+pin.issue+')';
  const artifactName='acceptance-result-'+pin.issue+'-'+stage+'-'+runId+'-'+attempt;
  const desired=pre?['SC-01','SC-02']:['SC-03'];
  if(run?.id!==runId||run.run_attempt!==attempt||
     run.name!==(pre?'Acceptance / Orchestrator':'Acceptance / Post-Run Waker')||
     run.path!==(pre?'.github/workflows/acceptance-orchestrator.yml':'.github/workflows/acceptance-postrun-waker.yml')||
     run.event!==(pre?'pull_request_target':'workflow_run')||
     run.head_sha!==target||run.status!=='completed'||run.conclusion!=='success'||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     !Number.isSafeInteger(run.repository?.id)||run.repository.id<=0||
     !Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    throw Error('unverified related Bug source workflow');
  function jobFor(suffix){
    const found=jobs.jobs.filter(x=>x.name===prefix+' / '+suffix);
    if(found.length!==1)throw Error('missing or ambiguous related Bug stage job');
    const j=found[0];
    if(!Number.isSafeInteger(j.id)||j.id<=0||j.run_id!==runId||
       j.run_attempt!==attempt||j.head_sha!==target||
       j.status!=='completed'||j.conclusion!=='success')
      throw Error('related Bug stage job does not match exact attempt');
    return j;
  }
  const executor=jobFor('Execute acceptance'),updater=jobFor('Deterministic Issue updater');
  if(!ACCEPTANCE_STEPS.every(n=>hasSuccess(executor,n))||!hasSuccess(updater,UPDATER))
    throw Error('source Bug independent Agent and trusted updater were not both successful');
  if(artifact?.name!==artifactName||artifact.expired!==false||
     !Number.isSafeInteger(artifact.id)||artifact.id<=0||
     !/^sha256:[0-9a-f]{64}$/.test(artifact.digest??'')||
     artifact.workflow_run?.id!==runId||
     artifact.workflow_run?.head_sha!==target||
     artifact.workflow_run?.repository_id!==run.repository.id||
     result?.schema_version!==1||result.issue!==pin.issue||
     result.run_id!==runId||result.stage!==stage||
     result.target_ref!==target||result.source!=='agent-cursor'||
     !/^[0-9a-f]{64}$/.test(result.contract_sha256??'')||
     !Array.isArray(result.selected_criteria)||!Array.isArray(result.criteria))
    throw Error('source Bug artifact/result has invalid source binding');
  for(const id of desired) {
    if(!result.selected_criteria.includes(id)||
       result.criteria.filter(x=>x?.criterion===id).length!==1||
       !result.criteria.some(x=>x.criterion===id&&x.result==='Pass'))
      throw Error('related Bug SC Pass is not present in source artifact: '+id);
  }
  if(result.criteria.length!==desired.length)
    throw Error('unexpected stage criteria in source Bug result');
  return {run_id:runId,attempt,head_sha:target,stage,executor_job:executor.id,
    updater_job:updater.id,artifact_id:artifact.id,artifact_digest:artifact.digest,
    pass_criteria:desired,contract_digest:result.contract_sha256};
}

// Historical evidence must be pinned inside an actual SC row. Both ## and
// ### Success Criteria are supported by the canonical Issue contract parser.
// Never inspect mutable Acceptance Reports, comments or arbitrary Issue prose.
export function historicalWitnessFromBugCriteria(body) {
  const match=String(body??'').match(/^#{2,3} Success Criteria[^\S\r\n]*\r?\n([\s\S]*?)(?=^#{1,3} [^\r\n]*|$(?![\s\S]))/m);
  if(!match)return null;
  const eligible=match[1].split(/\r?\n/).filter(line=>
    /^- \[[ x]\] SC-\d{2,}\b/.test(line) &&
    line.includes('Historical E2E witness:'));
  if(eligible.length!==1)return null;
  const candidates=[...eligible[0].matchAll(/Historical E2E witness: PR #(\d+) SHA ([a-f0-9]{40}); Reporter Fix PR #(\d+); E2E Run (\d+) attempt (\d+)/g)];
  return candidates.length===1?candidates[0]:null;
}

export function attestBugBootstrap(pin,sourceIssue,pr,pre,post,e2e,comparison,targetSha){
  if(!pin||pin.issue!==1725||pin.pr!==1830||!SHA.test(targetSha)||
     !sourceIssue||sourceIssue.number!==1725||sourceIssue.state!=='closed'||
     !!sourceIssue.pull_request||!Array.isArray(sourceIssue.labels)||
     !sourceIssue.labels.some(x=>x.name==='bug')||
     sourceIssue.labels.some(x=>x.name==='requirement')||
     !Array.isArray(sourceIssue.labels)||
     pr?.number!==1830||pr?.state!=='closed'||!pr.merged_at||
     pr?.head?.sha!==pin.head||pr?.merge_commit_sha!==pin.merge||
     pr?.head?.repo?.full_name!==REPO||pr?.base?.repo?.full_name!==REPO||
     pr?.base?.ref!=='main'||!SHA.test(pin.head)||!SHA.test(pin.merge)||
     !['ahead','identical'].includes(comparison?.status)||
     comparison.merge_base_commit?.sha!==pin.merge||
     comparison.behind_by!==0)
    throw Error('related Bug Issue/PR merge ancestry unverified');
  const successes=String(sourceIssue.body??'').match(/^- \[x\] SC-\d{2,}\b/gm)??[];
  if(successes.length!==3 || String(sourceIssue.body).match(/^- \[ \] SC-\d{2,}\b/gm))
    throw Error('related Bug source Issue contract is not completed');
  // The original Issue SC pins the unchanged PR-head rerun. Match the
  // historical source declaration to GitHub rather than accepting any green E2E.
  const historical=historicalWitnessFromBugCriteria(sourceIssue.body);
  if(!historical || Number(historical[1])!==1716 || Number(historical[3])!==1724 ||
      Number(historical[4])!==pin.e2eRun || Number(historical[5])!==pin.e2eAttempt ||
      !SHA.test(historical[2]) || e2e?.head_sha!==historical[2])
    throw Error('related Bug historical E2E source declaration unverified');
  if(e2e?.id!==pin.e2eRun||e2e.run_attempt!==pin.e2eAttempt||
     e2e.name!=='E2E / Tests'||e2e.path!=='.github/workflows/e2e-tests.yml'||
     e2e.event!=='pull_request'||e2e.status!=='completed'||
     e2e.conclusion!=='success'||e2e.repository?.full_name!==REPO||
     e2e.head_repository?.full_name!==REPO)
    throw Error('unverified source Bug historical E2E workflow');
  const preProof=verifiedStage(pin,'pre',...pre);
  const postProof=verifiedStage(pin,'post',...post);
  if(preProof.contract_digest!==postProof.contract_digest)
    throw Error('related Bug contract changed across trusted SC stages');
  return {kind:'verified_related_bug_completion',source_issue:pin.issue,subject_issue:1818,
    source_pr:pin.pr,pre_source_sha:pin.head,merge_sha:pin.merge,target_sha:targetSha,
    pre_merge_agent:preProof,post_merge_agent:postProof,
    historical_e2e_run:pin.e2eRun,historical_e2e_attempt:pin.e2eAttempt,
    historical_e2e_source_sha:e2e.head_sha,historical_e2e_conclusion:'success',
    provenance:'same-repo merged PR ancestry + exact GitHub attempts / jobs / independent Agent & updater + verified immutable artifacts + completed Bug Issue',
    limitation:'related source Bug proof only; does not grant Issue #1818 a Pass or assert latest-head E2E'};
}

export async function collectRelatedBugCompletion(repo,issue,targetSha,request,
   download=downloadedResult,token=process.env.GITHUB_TOKEN??process.env.GH_TOKEN) {
  const pin=pinnedBugBootstrap(issue?.body);
  if(!pin)return null;
  if(repo!==REPO || issue?.number!==1818 || !token || !SHA.test(targetSha))
    throw Error('related Bug completion collector unauthorized');
  const [sourceIssue,pr,e2e,preRun,postRun]=await Promise.all([
    request('/repos/'+repo+'/issues/'+pin.issue),
    request('/repos/'+repo+'/pulls/'+pin.pr),
    request('/repos/'+repo+'/actions/runs/'+pin.e2eRun+'/attempts/'+pin.e2eAttempt),
    request('/repos/'+repo+'/actions/runs/'+pin.preRun+'/attempts/'+pin.preAttempt),
    request('/repos/'+repo+'/actions/runs/'+pin.postRun+'/attempts/'+pin.postAttempt),
  ]);
  const [preJobs,postJobs,preArtifacts,postArtifacts,comparison]=await Promise.all([
    request('/repos/'+repo+'/actions/runs/'+pin.preRun+'/attempts/'+pin.preAttempt+'/jobs?per_page=100'),
    request('/repos/'+repo+'/actions/runs/'+pin.postRun+'/attempts/'+pin.postAttempt+'/jobs?per_page=100'),
    request('/repos/'+repo+'/actions/runs/'+pin.preRun+'/artifacts?per_page=100'),
    request('/repos/'+repo+'/actions/runs/'+pin.postRun+'/artifacts?per_page=100'),
    request('/repos/'+repo+'/compare/'+pin.merge+'...'+targetSha),
  ]);
  function select(list,name){
    if(!Array.isArray(list?.artifacts)||list.artifacts.length>100)
      throw Error('related Bug artifact listing untrusted');
    const found=list.artifacts.filter(x=>x?.name===name);
    if(found.length!==1)throw Error('related Bug expected artifact missing or duplicated');
    return found[0];
  }
  const preArtifact=select(preArtifacts,'acceptance-result-1725-pre-merge-'+pin.preRun+'-'+pin.preAttempt);
  const postArtifact=select(postArtifacts,'acceptance-result-1725-post-merge-'+pin.postRun+'-'+pin.postAttempt);
  const [preResult,postResult]=await Promise.all([
    download(repo,preArtifact,token),download(repo,postArtifact,token),
  ]);
  return attestBugBootstrap(pin,sourceIssue,pr,
    [preRun,preJobs,preArtifact,preResult],
    [postRun,postJobs,postArtifact,postResult],
    e2e,comparison,targetSha);
}
function selfTest() {
  const pin={issue:1725,pr:1830,head:'a'.repeat(40),merge:'b'.repeat(40),
    preRun:38733245163,preAttempt:2,postRun:38734877707,postAttempt:1,
    e2eRun:38387630403,e2eAttempt:3};
  const text='## Related Bug Completion Evidence\nRelated Bug witness: Issue #1725; PR #1830 HEAD '+pin.head+
    ' MERGE '+pin.merge+'; pre-merge Run 38733245163 attempt 2; post-merge Run 38734877707 attempt 1; E2E Run 38387630403 attempt 3\n\n## Next';
  assert.deepEqual(pinnedBugBootstrap(text),pin);
  const witness='Historical E2E witness: PR #1716 SHA '+('c'.repeat(40))+
    '; Reporter Fix PR #1724; E2E Run 38387630403 attempt 3';
  for(const heading of ['## Success Criteria','### Success Criteria']) {
    const valid=heading+'\n\n- [x] SC-03 regression: '+witness+
      '\n\n## Acceptance Plan\n'+witness;
    assert.equal(historicalWitnessFromBugCriteria(valid)?.[2],'c'.repeat(40));
    assert.equal(historicalWitnessFromBugCriteria(valid.replace('- [x] SC-03 regression:', 'Some prose:')),null);
    assert.equal(historicalWitnessFromBugCriteria(valid.replace('## Acceptance Plan','### Acceptance Report').replace('SC-03 regression:', 'SC-03 regression: '+witness+' ')),null);
  }
  assert.equal(historicalWitnessFromBugCriteria('## Acceptance Report\n'+witness),null);

  assert.equal(pinnedBugBootstrap('## Other\n- none'),null);
  assert.throws(()=>pinnedBugBootstrap(text.replace('pre-merge Run','pre Run')),/invalid/);
  const run=(stage)=>({id:stage==='pre'?pin.preRun:pin.postRun,
    run_attempt:stage==='pre'?2:1,name:stage==='pre'?'Acceptance / Orchestrator':'Acceptance / Post-Run Waker',
    path:stage==='pre'?'.github/workflows/acceptance-orchestrator.yml':'.github/workflows/acceptance-postrun-waker.yml',
    event:stage==='pre'?'pull_request_target':'workflow_run',
    head_sha:stage==='pre'?pin.head:pin.merge,status:'completed',conclusion:'success',
    repository:{id:1282055512,full_name:REPO},head_repository:{full_name:REPO}});
  const job=(stage,suffix,id,steps)=>({id,run_id:stage==='pre'?pin.preRun:pin.postRun,
    run_attempt:stage==='pre'?2:1,head_sha:stage==='pre'?pin.head:pin.merge,
    status:'completed',conclusion:'success',
    name:(stage==='pre'?'pre-merge-acceptance (1725)':'evaluate (1725)')+' / '+suffix,
    steps:steps.map(name=>({name,status:'completed',conclusion:'success'}))});
  const fixture=(stage)=>{
    const r=run(stage),isPre=stage==='pre';
    const executor=job(stage,'Execute acceptance',isPre?1:3,ACCEPTANCE_STEPS);
    const updater=job(stage,'Deterministic Issue updater',isPre?2:4,[UPDATER]);
    const artifact={id:isPre?51:52,name:'acceptance-result-1725-'+(isPre?'pre-merge':'post-merge')+'-'+r.id+'-'+r.run_attempt,
      digest:'sha256:'+'f'.repeat(64),expired:false,
      workflow_run:{id:r.id,head_sha:r.head_sha,repository_id:1282055512}};
    const ids=isPre?['SC-01','SC-02']:['SC-03'];
    const result={schema_version:1,issue:1725,run_id:r.id,stage:isPre?'pre-merge':'post-merge',
      target_ref:r.head_sha,source:'agent-cursor',contract_sha256:'e'.repeat(64),
      selected_criteria:ids,criteria:ids.map(criterion=>({criterion,result:'Pass'}))};
    return [r,{jobs:[executor,updater]},artifact,result];
  };
  const pre=fixture('pre'),post=fixture('post');
  const issue={number:1725,state:'closed',labels:[{name:'bug'}],
    body:'## Success Criteria\n- [x] SC-01 a\n- [x] SC-02 b\n- [x] SC-03 c Historical E2E witness: PR #1716 SHA '+('c'.repeat(40))+'; Reporter Fix PR #1724; E2E Run 38387630403 attempt 3'};
  const pr={number:1830,state:'closed',merged_at:'2026-10-15T12:00:00Z',
    head:{sha:pin.head,repo:{full_name:REPO}},
    base:{ref:'main',repo:{full_name:REPO}},merge_commit_sha:pin.merge};
  const e2e={id:pin.e2eRun,run_attempt:pin.e2eAttempt,name:'E2E / Tests',
    path:'.github/workflows/e2e-tests.yml',event:'pull_request',status:'completed',
    conclusion:'success',head_sha:'c'.repeat(40),
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const comparison={status:'ahead',merge_base_commit:{sha:pin.merge},behind_by:0};
  const target='d'.repeat(40);
  const check=(i=issue,p=pr,a=pre,b=post,e=e2e,c=comparison)=>
    attestBugBootstrap(pin,i,p,a,b,e,c,target);
  assert.deepEqual(check().post_merge_agent.pass_criteria,['SC-03']);
  for(const item of [
    ()=>check({...issue,state:'open'}),
    ()=>check({...issue,labels:[{name:'bug'},{name:'requirement'}]}),
    ()=>check(issue,{...pr,merge_commit_sha:pin.head}),
    ()=>check(issue,pr,[pre[0],pre[1],pre[2],{...pre[3],criteria:[]}]),
    ()=>check(issue,pr,[{...pre[0],run_attempt:3},...pre.slice(1)]),
    ()=>check(issue,pr,pre,[post[0],post[1],post[2],{...post[3],contract_sha256:'a'.repeat(64)}]),
    ()=>check(issue,pr,pre,post,{...e2e,conclusion:'failure'}),
    ()=>check({...issue,body:issue.body.replace('PR #1716', 'PR #1717')}),
    ()=>check({...issue,body:issue.body+'\nHistorical E2E witness: PR #1716 SHA '+('c'.repeat(40))+'; Reporter Fix PR #1724; E2E Run 38387630403 attempt 3'}),
    ()=>check(issue,pr,pre,post,e2e,{...comparison,merge_base_commit:{sha:pin.head}}),
  ]) assert.throws(item,/unverified|source|related|contract/);
  console.log('related Bug completed Acceptance receipts self-test passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  if(process.argv[2]!=='self-test')throw Error('usage: acceptance-bug-bootstrap-receipt.mjs self-test');
  selfTest();
}
