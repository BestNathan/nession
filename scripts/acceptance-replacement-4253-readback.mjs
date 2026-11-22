#!/usr/bin/env node
// #4253: independently attest the original #3784 replacement Acceptance
// from authoritative GitHub Run/Job/Artifact/Issue records. This is a bounded
// read-only cross-Issue observation, NEVER permission to project an SC Pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractSection, parseSuccessCriteria, parseAcceptanceReport,
  isAcceptanceIssue } from './requirement-acceptance.mjs';
import { validPrRequiredQualityReceipt } from './acceptance-pr-web-quality-receipt.mjs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO = 'BestNathan/nession';
const EXPECTED = Object.freeze({
  issue: 4253,
  source_issue: 3784,
  old_pr: 3919,
  new_pr: 4121,
  comment_id: 7071124882,
  request_run: 44963675195,
  acceptance_run: 44963729343,
  source_main_sha: '7481bac340e200b0e57fb217598920a1b403e775',
  replacement_head: '968965041e07ce0d2e63b0e49ed01d5f18f0901e',
  replacement_merge: 'a15ba4fd7e41fbec6d557a3078c75a3b37079b3e',
  old_sources: [
    '3c3ccba94ade08501a11dab35c483687e9823e41',
    '5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  ],
  criteria: ['SC-01','SC-02'],
});
const ARTIFACT = 'acceptance-result-3784-pr-44963729343-1';
const MAX_BYTES = 256*1024;
const SOURCE_PATHS = Object.freeze([
  'scripts/issue-lifecycle-reconcile.mjs',
  'scripts/acceptance-executor.mjs',
  'scripts/github-comment-command.mjs',
  '.github/workflows/agent-sc-acceptance.yml',
  '.github/workflows/acceptance-manual-request.yml',
]);

export function shouldCollectReplacement4253(stage, issue, targetSha) {
  return stage === 'post-merge' && Number(issue) === EXPECTED.issue &&
    SHA.test(String(targetSha || ''));
}

function deny(message) { throw Error('independent replacement readback: '+message); }
function requireCheck(value, message) { if (!value) deny(message); }
function runIdentity(run,id,name,workflow) {
  requireCheck(run?.id===id && run?.name===name &&
    run?.path===workflow && run.event==='workflow_dispatch' &&
    run.run_attempt===1 && run.head_branch==='main' &&
    run.head_sha===EXPECTED.source_main_sha &&
    run.repository?.full_name===REPO &&
    run.head_repository?.full_name===REPO &&
    run.status==='completed' && run.conclusion==='success',
    'exact protected main Run/source identity not verified');
}
function jobNamed(jobs,name,runId) {
  requireCheck(Array.isArray(jobs?.jobs) && jobs.jobs.length<100,
    'incomplete exact-attempt Job inventory');
  const selected=jobs.jobs.filter(j=>j?.name===name);
  requireCheck(selected.length===1,'missing or ambiguous trusted Job');
  const job=selected[0];
  requireCheck(Number.isSafeInteger(job.id) && job.id>0 &&
    job.run_id===runId && job.run_attempt===1 &&
    job.head_sha===EXPECTED.source_main_sha &&
    job.status==='completed' && job.conclusion==='success',
    'Job Run/Attempt/SHA/conclusion not authenticated');
  return job;
}
function goodStep(job,name) {
  const steps=(job?.steps??[]).filter(s=>s?.name===name);
  return steps.length===1 && steps[0].status==='completed' &&
    steps[0].conclusion==='success';
}
export function parseReplacementRequestLog(log) {
  requireCheck(typeof log==='string' && log.length<=2*1024*1024,
    'bounded trusted request Job log absent');
  const lines=log.split(/\r?\n/).filter(s=>s.includes('{"action":"dispatched"'));
  requireCheck(lines.length===1,'exactly one dispatch verdict required');
  const start=lines[0].indexOf('{"action":"dispatched"');
  let receipt;
  try { receipt=JSON.parse(lines[0].slice(start)); } catch { deny('malformed trusted dispatch log'); }
  requireCheck(receipt?.action==='dispatched' &&
    Array.isArray(receipt.agent_runs) && receipt.agent_runs.length===1 &&
    receipt.agent_runs[0].stage==='pr' &&
    receipt.agent_runs[0].target_ref===EXPECTED.replacement_head,
    'request did not dispatch exact independent replacement HEAD');
  return receipt;
}

export function attestReplacement4253(data, {repo=REPO,targetSha,
  qualityVerifier=validPrRequiredQualityReceipt}={}) {
  requireCheck(repo===REPO && SHA.test(String(targetSha||'')) &&
    typeof qualityVerifier==='function','untrusted target/repository');
  const mainCompare=data?.main_compare;
  requireCheck(mainCompare?.base_commit?.sha===EXPECTED.source_main_sha &&
    mainCompare?.merge_base_commit?.sha===EXPECTED.source_main_sha &&
    mainCompare.behind_by===0 &&
    ['identical','ahead'].includes(mainCompare.status) &&
    Number.isSafeInteger(mainCompare.ahead_by) &&
    mainCompare.ahead_by>=0 &&
    data?.source_unchanged===true,
    'current merged source does not contain unchanged original trust owners');
  const comment=data.comment;
  requireCheck(comment?.id===EXPECTED.comment_id &&
    comment.body==='/accept replace 3919 4121' &&
    comment.issue_url==='https://api.github.com/repos/'+REPO+'/issues/3784' &&
    comment.author_association==='OWNER' &&
    comment.user?.login==='BestNathan' && comment.user?.type==='User' &&
    comment.created_at && comment.updated_at===comment.created_at,
    'original unedited Owner comment not authenticated');
  runIdentity(data.request_run,EXPECTED.request_run,
    'Comment Accept #3784 comment:'+EXPECTED.comment_id,
    '.github/workflows/acceptance-manual-request.yml');
  runIdentity(data.acceptance_run,EXPECTED.acceptance_run,
    'Agent / SC Acceptance','.github/workflows/agent-sc-acceptance.yml');
  const requestJob=jobNamed(data.request_jobs,'request',EXPECTED.request_run);
  const execute=jobNamed(data.acceptance_jobs,'Execute acceptance',EXPECTED.acceptance_run);
  const update=jobNamed(data.acceptance_jobs,
    'Deterministic Issue updater',EXPECTED.acceptance_run);
  requireCheck(goodStep(requestJob,
    'Reconcile or dispatch existing stage-qualified Agent Acceptance') &&
    goodStep(execute,'Prepare stage-specific immutable acceptance context') &&
    goodStep(execute,'Run read-only Acceptance Agent') &&
    goodStep(execute,'Upload structured Acceptance Result') &&
    goodStep(update,'Apply Acceptance Report and checkbox projection'),
    'trusted Run lacked actual request, model, artifact or Issue projection');
  const requestOutcome=data.request_outcome;
  requireCheck(requestOutcome?.action==='dispatched' &&
    Array.isArray(requestOutcome.agent_runs) &&
    requestOutcome.agent_runs.length===1 &&
    requestOutcome.agent_runs[0].stage==='pr' &&
    requestOutcome.agent_runs[0].target_ref===EXPECTED.replacement_head,
    'Owner command did not actually dispatch replacement Agent');
  const a=data.artifact,run=data.acceptance_run;
  requireCheck(a?.name===ARTIFACT && a.expired===false &&
    Number.isSafeInteger(a.id) && a.id>0 &&
    Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes>0 &&
    a.size_in_bytes<=MAX_BYTES && DIGEST.test(String(a.digest||'')) &&
    a.workflow_run?.id===run.id &&
    a.workflow_run?.head_sha===run.head_sha &&
    a.workflow_run?.repository_id===run.repository?.id,
    'exact immutable Acceptance result Artifact unverified');
  const result=data.result,rep=result?.pr_source_replacement;
  requireCheck(result?.schema_version===1 &&
    result.issue===EXPECTED.source_issue && result.run_id===EXPECTED.acceptance_run &&
    result.stage==='pr' && result.source==='agent-qwen' &&
    result.target_ref===EXPECTED.replacement_head &&
    /^[0-9a-f]{64}$/.test(String(result.contract_sha256||'')) &&
    JSON.stringify([...(result.selected_criteria??[])].sort())===
      JSON.stringify(EXPECTED.criteria) &&
    Array.isArray(result.criteria) && result.criteria.length===2 &&
    EXPECTED.criteria.every(id=>result.criteria.filter(c=>
      c.criterion===id && c.result==='Pass' &&
      Array.isArray(c.evidence) && c.evidence.length>0).length===1) &&
    qualityVerifier(result.pr_required_quality_receipt,EXPECTED.replacement_head),
    'new source Agent result or exact-head Quality not authenticated');
  requireCheck(rep?.issue===EXPECTED.source_issue &&
    rep.previous_pr===EXPECTED.old_pr && rep.replacement_pr===EXPECTED.new_pr &&
    rep.target_ref===EXPECTED.replacement_head &&
    rep.comment_id===EXPECTED.comment_id &&
    JSON.stringify([...(rep.criteria??[])].sort())===JSON.stringify(EXPECTED.criteria) &&
    JSON.stringify([...(rep.old_sources??[])].sort())===
      JSON.stringify(EXPECTED.old_sources),
    'new signed result lacks independently verified historical-source separation');
  const issue=data.issue;
  requireCheck(issue?.number===EXPECTED.source_issue &&
    issue.state==='closed' && issue.state_reason==='completed' &&
    !issue.pull_request && isAcceptanceIssue(issue),
    'original Issue not canonically closed');
  const sc=parseSuccessCriteria(extractSection(issue.body,'Success Criteria'));
  const report=parseAcceptanceReport(extractSection(issue.body,'Acceptance Report'));
  requireCheck(!sc.errors.length && !report.errors.length &&
    EXPECTED.criteria.every(id=>sc.criteria.get(id)?.checked===true &&
      report.rows.get(id)?.result==='Pass' &&
      new RegExp('^run '+EXPECTED.acceptance_run+'; ref '+
        EXPECTED.replacement_head+'; source agent-qwen;').test(
          String(report.rows.get(id)?.evidence||''))),
    'original Issue does not project both exact new-source Agent Passes');
  const history=extractSection(issue.body,'Acceptance Source Recovery History');
  requireCheck(issue.body.includes('<!-- independent-replacement:3919:4121:'+
    EXPECTED.acceptance_run+' -->') &&
    EXPECTED.old_sources.every(sha=>history.includes(sha)),
    'historical source receipts were overwritten or deleted');
  const old=data.old_pr,newPr=data.new_pr;
  const localRepo=pr=>pr?.head?.repo?.full_name===REPO &&
    pr?.base?.repo?.full_name===REPO &&
    Boolean(pr.merged_at);
  requireCheck(old?.number===EXPECTED.old_pr && localRepo(old) &&
    old.base.ref==='main' && /Refs #3784/.test(String(old.body||'')) &&
    newPr?.number===EXPECTED.new_pr && localRepo(newPr) &&
    newPr.base.ref==='staging' &&
    newPr.head.sha===EXPECTED.replacement_head &&
    newPr.merge_commit_sha===EXPECTED.replacement_merge &&
    old.merged_at<newPr.merged_at &&
    Array.isArray(data.associated_pulls) &&
    data.associated_pulls.length<100 &&
    data.associated_pulls.some(p=>p.number===EXPECTED.new_pr &&
      Boolean(p.merged_at) && p.head?.sha===EXPECTED.replacement_head &&
      p.head?.repo?.full_name===REPO && p.base?.repo?.full_name===REPO &&
      p.base?.ref==='staging'),
    'original/replacement PRs not independently authenticated');
  const stageCompare=data.stage_compare;
  requireCheck(stageCompare?.base_commit?.sha===EXPECTED.replacement_merge &&
    stageCompare.merge_base_commit?.sha===EXPECTED.replacement_merge &&
    stageCompare.behind_by===0 &&
    ['identical','ahead'].includes(stageCompare.status) &&
    Number.isSafeInteger(stageCompare.ahead_by) &&
    stageCompare.ahead_by>=0,
    'replacement staging merge no longer ancestral to protected destination');
  return Object.freeze({
    kind:'authenticated_independent_replacement_acceptance_completion',
    verdict:'Verified',
    acceptance_issue:EXPECTED.issue,source_issue:EXPECTED.source_issue,
    target_sha:targetSha,
    original_main_sha:EXPECTED.source_main_sha,
    owner_comment_id:EXPECTED.comment_id,
    owner_request_run_id:EXPECTED.request_run,
    owner_request_job_id:requestJob.id,
    acceptance_run_id:EXPECTED.acceptance_run,
    acceptance_executor_job_id:execute.id,
    acceptance_updater_job_id:update.id,
    acceptance_artifact_id:a.id,acceptance_artifact_digest:a.digest,
    original_pr:EXPECTED.old_pr,replacement_pr:EXPECTED.new_pr,
    replacement_head_sha:EXPECTED.replacement_head,
    replacement_merge_sha:EXPECTED.replacement_merge,
    new_sc_results:{'SC-01':'Pass','SC-02':'Pass'},
    original_issue_state:'closed',
    original_issue_state_reason:'completed',
    historical_source_refs_preserved:[...EXPECTED.old_sources],
    source_integrity:'original source owners unchanged; current target includes authenticated prior main ancestor',
    provenance:'Original unedited Owner comment + exact successful main request Job dispatch log + exact successful Agent/Projector Jobs + downloaded immutable exact-attempt result Artifact + source-bound required Quality + actual Closed Issue checked rows + preserved history + authenticated merged PR ancestry',
    limitation:'Read-only observation of the original completed Issue; this receipt does not itself authorize the acceptance or closure of Issue #4253',
  });
}
function loadExactResult(repo,runId,name) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-replacement-proof-'));
  try {
    execFileSync('gh',['run','download',String(runId),'--repo',repo,
      '--name',name,'--dir',root],{
      encoding:'utf8',timeout:45000,maxBuffer:MAX_BYTES,
      stdio:['ignore','pipe','pipe'],
    });
    const entries=fs.readdirSync(root);
    requireCheck(entries.length===1 && entries[0]==='acceptance-result.json',
      'downloaded Acceptance artifact contains unexpected files');
    const full=path.join(root,'acceptance-result.json');
    const stat=fs.lstatSync(full);
    requireCheck(stat.isFile() && stat.size>0 && stat.size<=MAX_BYTES,
      'downloaded result not a bounded regular JSON file');
    return JSON.parse(fs.readFileSync(full,'utf8'));
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
export async function collectReplacement4253({repo=REPO,targetSha,stage,issue,
  get,getLog,sourceUnchanged,loadResult=loadExactResult}={}) {
  if(!shouldCollectReplacement4253(stage,issue,targetSha))return null;
  requireCheck(repo===REPO && typeof get==='function' &&
    typeof getLog==='function' && typeof sourceUnchanged==='function',
    'untrusted readback caller');
  const api='/repos/'+repo;
  const [sourceIssue,comment,requestRun,acceptanceRun,requestJobs,acceptanceJobs,
    artifacts,oldPr,newPr,associated,mainCompare,stagingBranch]=await Promise.all([
    get(api+'/issues/'+EXPECTED.source_issue),
    get(api+'/issues/comments/'+EXPECTED.comment_id),
    get(api+'/actions/runs/'+EXPECTED.request_run),
    get(api+'/actions/runs/'+EXPECTED.acceptance_run),
    get(api+'/actions/runs/'+EXPECTED.request_run+'/jobs?per_page=100'),
    get(api+'/actions/runs/'+EXPECTED.acceptance_run+'/jobs?per_page=100'),
    get(api+'/actions/runs/'+EXPECTED.acceptance_run+'/artifacts?per_page=100'),
    get(api+'/pulls/'+EXPECTED.old_pr),
    get(api+'/pulls/'+EXPECTED.new_pr),
    get(api+'/commits/'+EXPECTED.replacement_head+'/pulls?per_page=100'),
    get(api+'/compare/'+EXPECTED.source_main_sha+'...'+targetSha),
    get(api+'/branches/staging'),
  ]);
  requireCheck(Array.isArray(artifacts?.artifacts) &&
    artifacts.artifacts.length<100,'unbounded Acceptance Artifact inventory');
  const found=artifacts.artifacts.filter(a=>a?.name===ARTIFACT);
  requireCheck(found.length===1,'missing or duplicate exact Acceptance Artifact');
  requireCheck(SHA.test(String(stagingBranch?.commit?.sha||'')),
    'missing independently read protected staging HEAD');
  const [stageCompare,requestLog,result,unchanged]=await Promise.all([
    get(api+'/compare/'+EXPECTED.replacement_merge+'...'+stagingBranch.commit.sha),
    (async()=>getLog(jobNamed(requestJobs,'request',EXPECTED.request_run).id))(),
    (async()=>loadResult(repo,EXPECTED.acceptance_run,ARTIFACT))(),
    Promise.resolve(sourceUnchanged(EXPECTED.source_main_sha,targetSha,SOURCE_PATHS)),
  ]);
  return attestReplacement4253({
    issue:sourceIssue,comment,request_run:requestRun,
    acceptance_run:acceptanceRun,request_jobs:requestJobs,
    acceptance_jobs:acceptanceJobs,request_outcome:parseReplacementRequestLog(requestLog),
    artifact:found[0],result,old_pr:oldPr,new_pr:newPr,
    associated_pulls:associated,main_compare:mainCompare,
    stage_compare:stageCompare,source_unchanged:unchanged,
  },{repo,targetSha});
}

export function selfTestReplacement4253() {
  const m=EXPECTED.source_main_sha,head=EXPECTED.replacement_head;
  const makeRun=(id,name,workflow)=>({
    id,name,path:workflow,event:'workflow_dispatch',run_attempt:1,
    head_branch:'main',head_sha:m,status:'completed',conclusion:'success',
    repository:{full_name:REPO,id:1282055512},
    head_repository:{full_name:REPO,id:1282055512},
  });
  const mkJob=(id,name,runId,steps)=>({
    id,name,run_id:runId,run_attempt:1,head_sha:m,
    status:'completed',conclusion:'success',
    steps:steps.map(name=>({name,status:'completed',conclusion:'success'})),
  });
  const issueBody=[
    '## Success Criteria','- [x] SC-01 reattested','- [x] SC-02 reattested',
    '','## Acceptance Report','| Criterion | Result | Evidence |',
    '|---|---|---|',
    ...EXPECTED.criteria.map(id=>'| '+id+' | Pass | run '+EXPECTED.acceptance_run+
      '; ref '+head+'; source agent-qwen; test: new source |'),
    '','## Acceptance Source Recovery History',
    '<!-- independent-replacement:3919:4121:'+EXPECTED.acceptance_run+' -->',
    ...EXPECTED.old_sources.map(sha=>'- historical source ref '+sha),
  ].join('\n');
  const pr=(n,base,sha,when,merge)=>({
    number:n,merged_at:when,body:'Refs #3784.',
    head:{sha,repo:{full_name:REPO}},
    base:{ref:base,repo:{full_name:REPO}},
    merge_commit_sha:merge,
  });
  const old=pr(3919,'main','c'.repeat(40),'2026-11-19T20:00:00Z','d'.repeat(40));
  const replacement=pr(4121,'staging',head,'2026-11-20T20:00:00Z',
    EXPECTED.replacement_merge);
  const data={
    source_unchanged:true,
    main_compare:{base_commit:{sha:m},merge_base_commit:{sha:m},
      behind_by:0,ahead_by:1,status:'ahead'},
    stage_compare:{base_commit:{sha:EXPECTED.replacement_merge},
      merge_base_commit:{sha:EXPECTED.replacement_merge},
      behind_by:0,ahead_by:7,status:'ahead'},
    comment:{id:EXPECTED.comment_id,body:'/accept replace 3919 4121',
      issue_url:'https://api.github.com/repos/'+REPO+'/issues/3784',
      author_association:'OWNER',user:{login:'BestNathan',type:'User'},
      created_at:'2026-11-21T23:49:09Z',updated_at:'2026-11-21T23:49:09Z'},
    request_run:makeRun(EXPECTED.request_run,'Comment Accept #3784 comment:'+
      EXPECTED.comment_id,'.github/workflows/acceptance-manual-request.yml'),
    acceptance_run:makeRun(EXPECTED.acceptance_run,'Agent / SC Acceptance',
      '.github/workflows/agent-sc-acceptance.yml'),
    request_jobs:{jobs:[mkJob(11,'request',EXPECTED.request_run,
      ['Reconcile or dispatch existing stage-qualified Agent Acceptance'])]},
    acceptance_jobs:{jobs:[
      mkJob(12,'Execute acceptance',EXPECTED.acceptance_run,
        ['Prepare stage-specific immutable acceptance context',
         'Run read-only Acceptance Agent','Upload structured Acceptance Result']),
      mkJob(13,'Deterministic Issue updater',EXPECTED.acceptance_run,
        ['Apply Acceptance Report and checkbox projection']),
    ]},
    request_outcome:{action:'dispatched',
      agent_runs:[{stage:'pr',target_ref:head}]},
    artifact:{name:ARTIFACT,expired:false,id:14730548163,
      size_in_bytes:1500,digest:'sha256:'+'a'.repeat(64),
      workflow_run:{id:EXPECTED.acceptance_run,head_sha:m,
        repository_id:1282055512}},
    result:{schema_version:1,issue:3784,run_id:EXPECTED.acceptance_run,
      stage:'pr',source:'agent-qwen',target_ref:head,
      contract_sha256:'b'.repeat(64),
      selected_criteria:[...EXPECTED.criteria],
      criteria:EXPECTED.criteria.map(criterion=>({criterion,result:'Pass',
        evidence:[{type:'test',value:'source-bound real run'}]})),
      pr_required_quality_receipt:{fixture:true},
      pr_source_replacement:{issue:3784,previous_pr:3919,replacement_pr:4121,
        comment_id:EXPECTED.comment_id,target_ref:head,
        old_sources:[...EXPECTED.old_sources],criteria:[...EXPECTED.criteria]}},
    issue:{number:3784,state:'closed',state_reason:'completed',
      labels:[{name:'bug'}],body:issueBody},
    old_pr:old,new_pr:replacement,
    associated_pulls:[replacement],
  };
  const args={targetSha:'f'.repeat(40),qualityVerifier:()=>true};
  const verify=d=>attestReplacement4253(d,args);
  assert.equal(verify(data).verdict,'Verified');
  assert.equal(verify(data).original_issue_state,'closed');
  assert.equal(shouldCollectReplacement4253('post-merge',4253,args.targetSha),true);
  assert.equal(shouldCollectReplacement4253('pr',4253,args.targetSha),false);
  const malformed=[
    {...data,source_unchanged:false},
    {...data,main_compare:{...data.main_compare,status:'diverged'}},
    {...data,comment:{...data.comment,author_association:'COLLABORATOR'}},
    {...data,comment:{...data.comment,updated_at:'2026-11-21T23:49:10Z'}},
    {...data,request_run:{...data.request_run,conclusion:'failure'}},
    {...data,acceptance_run:{...data.acceptance_run,head_sha:'0'.repeat(40)}},
    {...data,request_outcome:{action:'pending',agent_runs:[]}},
    {...data,artifact:{...data.artifact,digest:'sha256:bad'}},
    {...data,result:{...data.result,target_ref:'0'.repeat(40)}},
    {...data,result:{...data.result,pr_source_replacement:{
      ...data.result.pr_source_replacement,comment_id:1}}},
    {...data,issue:{...data.issue,state:'open'}},
    {...data,issue:{...data.issue,body:data.issue.body.replace(
      EXPECTED.old_sources[0],'f'.repeat(40))}},
    {...data,associated_pulls:[]},
    {...data,stage_compare:{...data.stage_compare,behind_by:1}},
    {...data,new_pr:{...replacement,head:{...replacement.head,repo:{
      full_name:'attacker/fork'}}}},
  ];
  for(const mutation of malformed)
    assert.throws(()=>verify(mutation),/independent replacement readback:/);
  assert.deepEqual(parseReplacementRequestLog('2026-11-21T23:50:27Z '+
    '{"action":"dispatched","agent_runs":[{"stage":"pr","target_ref":"'+head+'"}]}'),
    data.request_outcome);
  assert.throws(()=>parseReplacementRequestLog('{"action":"pending","agent_runs":[]}'),
    /independent replacement readback:/);
  console.log('independent replacement: exact Owner/Run/Job/Artifact/Issue, ancestry and hostile fixtures passed');
}
