#!/usr/bin/env node
// #4445: trusted main reconciles an independently executed PR Quality Gate.
// The existing Outbox and Store CAS own every transition; no model dispatch,
// PR merge, Issue acceptance projection, or historical-state rewrite occurs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {acceptTaskResult,recordDispatch,validateDevelopmentState} from './outbox.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState,issueStatePath} from './state-store.mjs';
import {validateAuthenticatedAgentReceipt,createGitHubResultArtifactReader} from './result-artifact.mjs';
import {planAcceptanceReconciliation} from './acceptance-reconcile.mjs';
import {collectPrRequiredQualityAsync,validPrRequiredQualityReceipt} from '../../../acceptance-pr-web-quality-receipt.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const REPO='BestNathan/nession', WORKFLOW='.github/workflows/ci-quality.yml';
const SHA=/^[a-f0-9]{40}$/, positive=n=>Number.isSafeInteger(n)&&n>0;
const pending=reason=>({status:'pending',reason});
function fail(reason){throw Error('trusted quality reconcile: '+reason);}
export function prMatches(pr,number,sha){
  return pr?.number===number&&pr.state==='open'&&pr.head?.sha===sha&&
    pr.head?.repo?.full_name===REPO&&pr.base?.repo?.full_name===REPO&&
    ['main','staging'].includes(pr.base?.ref)&&typeof pr.head.ref==='string';
}
export function associated(run,pr){
  return run?.head_sha===pr.head.sha&&run.head_branch===pr.head.ref&&
    Array.isArray(run.pull_requests)&&run.pull_requests.some(p=>
      p?.number===pr.number&&p.head?.sha===pr.head.sha&&
      p.head?.ref===pr.head.ref&&p.base?.ref===pr.base.ref&&
      p.head?.repo?.id===pr.head.repo.id&&p.base?.repo?.id===pr.base.repo.id&&
      positive(pr.head.repo.id)&&positive(pr.base.repo.id));
}
export function approvedBinding(state,reviewerReceipt){
  const latest=state.transitions.findLast(t=>t.kind==='reviewer');
  if(!['quality','acceptance'].includes(state.phase)||latest?.outcome!=='approved'||
      latest.target_sha!==state.target_sha||
      !state.transitions.some(t=>t.kind==='publisher'&&t.outcome==='published'&&
        t.target_sha===state.target_sha))return null;
  const r=validateAuthenticatedAgentReceipt(reviewerReceipt);
  if(r.schema_version!==2||r.issue!==state.issue||r.result.kind!=='reviewer'||
      r.result.outcome!=='approved'||r.result.run_id!==latest.run_id||
      r.result.run_attempt!==latest.attempt||r.result.target_sha!==state.target_sha||
      r.source.input_sha!==state.target_sha||r.source.agent_id!==state.assignments.reviewer)
    fail('Reviewer receipt does not bind current approved publication');
  return r.implementing_pr.number;
}

// request is a trusted GitHub REST reader. The canonical Quality attestor
// remains the sole job/step policy. Narrow the source run listing to the
// authenticated implementing PR; absent PR association fails closed.
export async function planQualityReconciliation({state,expectedVersion,reviewerReceipt,request,registry}){
  validateDevelopmentState(state);
  if(state.version!==expectedVersion)fail('stale state CAS');
  if(state.phase!=='quality')return pending('not awaiting Quality');
  const prNumber=approvedBinding(state,reviewerReceipt);
  if(!prNumber)return pending('current publication lacks approved Reviewer');
  const actions=state.outbox.filter(a=>a.task.type==='verify'&&a.task.gate==='quality'&&
    a.task.sha===state.target_sha&&a.status==='pending');
  if(actions.length!==1)return pending('no unique pending exact-HEAD Quality action');
  const action=actions[0],sha=state.target_sha;
  const pr=await request('/repos/'+REPO+'/pulls/'+prNumber);
  if(!prMatches(pr,prNumber,sha))return pending('implementing PR closed or changed');
  const issue=await request('/repos/'+REPO+'/issues/'+state.issue);
  if(issue?.number!==state.issue||issue.state!=='open'||issue.pull_request)
    return pending('owning Issue is not open');
  const proof=await collectPrRequiredQualityAsync(sha,async endpoint=>{
    const value=await request(endpoint);
    if(endpoint.includes('/actions/workflows/ci-quality.yml/runs?')){
      if(!Array.isArray(value?.workflow_runs)||value.total_count>value.workflow_runs.length)
        return {workflow_runs:[]};
      return {...value,workflow_runs:value.workflow_runs.filter(run=>associated(run,pr))};
    }
    return value;
  });
  if(proof.status!=='pass'||!validPrRequiredQualityReceipt(proof.receipt,sha))
    return pending(proof.reason??'Quality not authenticated');
  const q=proof.receipt;
  // Re-read latest attempt and live PR after job attestation; an old
  // successful attempt or a PR updated during readback cannot advance.
  const run=await request('/repos/'+REPO+'/actions/runs/'+q.run_id);
  const live=await request('/repos/'+REPO+'/pulls/'+prNumber);
  if(!prMatches(live,prNumber,sha)||live.head.ref!==pr.head.ref||
      live.base.ref!==pr.base.ref||!associated(run,live)||run.id!==q.run_id||
      run.run_attempt!==q.run_attempt||run.status!=='completed'||run.conclusion!=='success'||
      run.name!=='CI / Quality Gate'||![WORKFLOW,WORKFLOW+'@refs/heads/main'].includes(run.path)||
      run.event!=='pull_request'||run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO)
    return pending('Quality run attempt or live PR binding changed');
  const acknowledged=recordDispatch(state,expectedVersion,action.id,{
    status:'verified',dispatch_id:action.id,source_run_id:q.run_id,
  });
  const result={kind:'quality',issue:state.issue,run_id:q.run_id,
    run_attempt:q.run_attempt,target_sha:sha,outcome:'passed',task_id:action.id};
  // ref identifies the protected-main attestor; event describes the
  // independently observed PR Quality source, not a fabricated dispatch.
  const source={repository:REPO,path:WORKFLOW,name:'CI / Quality Gate',
    run_id:q.run_id,attempt:q.run_attempt,event:'pull_request',ref:'refs/heads/main',
    issue:state.issue,task_id:action.id,agent_id:null,input_sha:sha,output_sha:sha,verified:true};
  const next=acceptTaskResult(acknowledged,acknowledged.version,result,source,registry);
  return {status:'verified',pr:prNumber,quality_receipt:q,action_id:action.id,
    acknowledged,next,expectedVersion,expectedDigest:stateDigest(state)};
}

function git(root,args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
    maxBuffer:2*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}catch{fail('Store Git '+args[0]+' failed');}
}
function clone(remote,dir){
  if(typeof remote!=='string'||!remote.startsWith('https://x-access-token:')||
      !remote.endsWith('@github.com/'+REPO+'.git')||/\s/.test(remote))fail('invalid scoped Store remote');
  try{execFileSync('git',['clone','--no-tags','--single-branch','--branch','agent-store','--',remote,dir],
    {stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:2*1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});}
  catch{fail('trusted Store checkout unavailable');}
  if(git(dir,['symbolic-ref','--short','HEAD'])!=='agent-store')fail('unexpected Store ref');
}
function readApprovedReceipt(store,state){
  const latest=state.transitions.findLast(t=>t.kind==='reviewer');
  if(latest?.kind!=='reviewer'||latest.outcome!=='approved'||!positive(latest.run_id)||
      !positive(latest.attempt))return null;
  const dir=path.join(store,'workflows','issues',String(state.issue),'results');
  if(!fs.existsSync(dir))return null;
  if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())fail('unsafe Reviewer results directory');
  const prefix=latest.run_id+'-'+latest.attempt+'-';
  const candidates=fs.readdirSync(dir,{withFileTypes:true}).filter(d=>
    d.isFile()&&!d.isSymbolicLink()&&d.name.startsWith(prefix)&&
    /^[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/.test(d.name));
  if(candidates.length!==1)return null;
  const filename=path.join(dir,candidates[0].name);
  if(fs.statSync(filename).size>65536)fail('Reviewer receipt exceeds bound');
  const receipt=validateAuthenticatedAgentReceipt(JSON.parse(fs.readFileSync(filename,'utf8')));
  if(candidates[0].name!==prefix+receipt.action_id+'.json')fail('Reviewer receipt path mismatch');
  return receipt;
}
export const stateDigest=state=>createHash('sha256').update(JSON.stringify(state,null,2)+'\n').digest('hex');
export function stageQualityReconciliation(store,plan){
  if(plan.status!=='verified')fail('Quality proof not verified');
  const issue=plan.next.issue;
  const current=readIssueWorkflowState(store,issue);
  if(current.version!==plan.expectedVersion||current.digest!==plan.expectedDigest||
      current.state?.outbox.find(a=>a.id===plan.action_id)?.status!=='pending')
    fail('stale state CAS');
  // Both versions are staged in one remote CAS commit; never publish the
  // intermediate verification receipt alone.
  writeIssueWorkflowState(store,plan.acknowledged,current.version);
  writeIssueWorkflowState(store,plan.next,plan.acknowledged.version);
  const t=plan.next.transitions.at(-1);
  const proof=plan.acceptance_receipt??plan.quality_receipt;
  const rel='workflows/issues/'+issue+'/verification-results/'+t.run_id+'-'+t.attempt+'-'+plan.action_id+'.json';
  const dir=path.join(store,path.dirname(rel));
  if(!fs.existsSync(dir))fs.mkdirSync(dir);
  if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())fail('unsafe verification receipt directory');
  const record={schema_version:1,kind:t.kind,issue,pr:plan.pr,action_id:plan.action_id,
    target_sha:t.target_sha,run_id:t.run_id,run_attempt:t.attempt,
    prior_state_sha256:plan.expectedDigest,result_state_sha256:stateDigest(plan.next),proof};
  fs.writeFileSync(path.join(store,rel),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return [issueStatePath(issue,plan.acknowledged.version),issueStatePath(issue,plan.next.version),
    'workflows/issues/'+issue+'/head.json',rel];
}
function rest(token){
  if(typeof token!=='string'||token.length<8)fail('missing trusted REST read token');
  return async endpoint=>{
    if(!endpoint.startsWith('/repos/'+REPO+'/'))fail('unexpected REST endpoint');
    const response=await fetch('https://api.github.com'+endpoint,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10'},signal:AbortSignal.timeout(30000)});
    if(!response.ok)fail('GitHub REST read failed: '+response.status);
    return response.json();
  };
}
async function main(){
  const e=process.env;
  if(process.argv.length!==3||process.argv[2]!=='reconcile'||
      e.GITHUB_REPOSITORY!==REPO||e.GITHUB_REF!=='refs/heads/main'||
      e.GITHUB_WORKFLOW!=='Store / Agent Dispatch Reconcile'||
      !['schedule','workflow_dispatch'].includes(e.GITHUB_EVENT_NAME)||
      !SHA.test(e.GITHUB_SHA??'')||git(process.cwd(),['rev-parse','HEAD'])!==e.GITHUB_SHA)
    fail('protected main verification reconciliation only');
  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const request=rest(e.GH_TOKEN),artifactReader=createGitHubResultArtifactReader(e.GH_TOKEN),root=fs.mkdtempSync(path.join(os.tmpdir(),'quality-reconcile-'));
  try{
    const store=path.join(root,'agent-store');
    clone(e.AGENT_STORE_CONTROLLER_REMOTE,store);
    const dirs=fs.readdirSync(path.join(store,'workflows','issues'),{withFileTypes:true})
      .filter(d=>d.isDirectory()&&!d.isSymbolicLink()&&/^[1-9][0-9]*$/.test(d.name)&&positive(Number(d.name)))
      .map(d=>Number(d.name)).sort((a,b)=>a-b);
    if(dirs.length>5000)fail('Issue state listing exceeds bound');
    const candidates=dirs.filter(issue=>readIssueWorkflowState(store,issue).state&&['quality','acceptance'].includes(readIssueWorkflowState(store,issue).state.phase));
    const runNumber=Number(e.GITHUB_RUN_NUMBER);
    if(!positive(runNumber))fail('missing trusted run ordinal');
    // Rotate over at most eight candidates per invocation, even when older
    // closed/stale sources remain in the immutable Store.
    const start=candidates.length?((runNumber-1)*8)%candidates.length:0;
    const ordered=candidates.slice(start).concat(candidates.slice(0,start)).slice(0,8);
    for(const issue of ordered){
      const {state,version}=readIssueWorkflowState(store,issue);
      if(!state||!['quality','acceptance'].includes(state.phase))continue;
      const receipt=readApprovedReceipt(store,state);
      if(!receipt){console.log(JSON.stringify({issue,status:'pending',reason:'no bound Reviewer receipt'}));continue;}
      const args={state,expectedVersion:version,reviewerReceipt:receipt,request,registry,artifactReader};
      const plan=state.phase==='quality'?await planQualityReconciliation(args):await planAcceptanceReconciliation(args);
      if(plan.status!=='verified'){console.log(JSON.stringify({issue,...plan}));continue;}
      const paths=stageQualityReconciliation(store,plan);
      git(store,['add','--',...paths]);
      if(auditStagedRunStore(store,'agent-store').checked_changes!==4)
        fail('Verification CAS must add two immutable state versions, receipt and head');
      git(store,['-c','user.name=nession-agent-controller','-c',
        'user.email=nession-agent-controller@users.noreply.github.com','commit','-m',
        'agent-store: authenticate '+state.phase+' result for Issue '+issue]);
      const pushed=publish('agent-store',store,4);
      const actual=readIssueWorkflowState(store,issue),expected=plan.next.transitions.at(-1);
      if(actual.version<plan.next.version||!actual.state.transitions.some(t=>t.kind===expected.kind&&
          t.run_id===expected.run_id&&t.attempt===expected.attempt&&
          t.target_sha===state.target_sha&&t.outcome==='passed')||
          !fs.existsSync(path.join(store,paths[3])))fail('post-CAS verification readback missing');
      console.log(JSON.stringify({issue,status:'accepted',pr:plan.pr,action_id:plan.action_id,
        proof:plan.acceptance_receipt??plan.quality_receipt,state_version:plan.next.version,
        store_commit_sha:pushed.commit_sha}));
      // One mutation per invocation bounds the writer and allows the next
      // schedule to recover any lost wake without replaying a model.
      return;
    }
    console.log(JSON.stringify({status:'no-eligible-quality',scanned:ordered.length,candidates:candidates.length}));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
