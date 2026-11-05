#!/usr/bin/env node
// Main-owned Reviewer -> immutable Store -> Issue projection.
// The worker never holds these credentials. A Metrics branch record is an
// independent, previously committed witness; a model verdict has no write
// authority and cannot choose the next role.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createGitHubRunReader,verifyDispatchTicket,
  attestSkippedDispatchRebinding} from './github-dispatch.mjs';
import {createGitHubResultArtifactReader,readAuthenticatedReviewClaim,
  ingestAgentResult,appendAuthenticatedResult,
  validateAuthenticatedAgentReceipt} from './result-artifact.mjs';
import {acceptTaskResult,recordReboundDispatch} from './outbox.mjs';
import {readIssueWorkflowState,writeIssueWorkflowState} from './state-store.mjs';
import {deriveDispatchKey} from './controller-dispatch.mjs';
import {validateAgentWorkflowTelemetry,telemetryStoragePath}
  from '../../../agent-workflow-telemetry.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(s){throw Error('trusted Reviewer result ingest: '+s);}
function sha(b){return createHash('sha256').update(b).digest('hex');}
function git(root,args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
    maxBuffer:2*1024*1024,env:{...process.env,
      GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}catch{fail('authenticated Store Git '+args[0]+' failed');}
}
function clone(remote,branch,dir){
  if(typeof remote!=='string'||!remote||remote.length>2000||/\s/.test(remote))
    fail('invalid Store remote');
  try{execFileSync('git',['clone','--no-tags','--single-branch','--branch',
    branch,'--',remote,dir],{stdio:['ignore','pipe','pipe'],
      timeout:45000,maxBuffer:2*1024*1024,env:{...process.env,
        GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}});}
  catch{fail('trusted '+branch+' checkout unavailable');}
  if(git(dir,['symbolic-ref','--short','HEAD'])!==branch)
    fail('unexpected Store ref');
}
export function authenticateReviewerRun(run,expectedId,attempt) {
  if(!positive(expectedId)||!positive(attempt)||run?.id!==expectedId||
     run.run_attempt!==attempt||run.path!=='.github/workflows/agent-review.yml'||
     run.name!=='Agent / Review'||run.event!=='workflow_dispatch'||
     run.head_branch!=='main'||!HEX40.test(run.head_sha??'')||
     run.status!=='completed'||run.conclusion!=='success'||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     !['BestNathan','github-actions[bot]'].includes(run.actor?.login))
    fail('source is not the successful trusted main Reviewer Run');
  return run;
}
// The Metrics witness must originate from the canonical immutable metrics ref,
// not from the Review artifact, Issue thread, or agent-store.
export function findReviewerMetrics(metricsRoot,run) {
  const base=path.join(metricsRoot,'raw','workflows','agent-review');
  if(!fs.existsSync(base)||!fs.lstatSync(base).isDirectory()||
     fs.lstatSync(base).isSymbolicLink())fail('Reviewer Metrics have not been persisted');
  let scanned=0;
  const found=[];
  for(const date of fs.readdirSync(base)){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('invalid Metrics partition');
    const dir=path.join(base,date),stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe Metrics partition');
    for(const name of fs.readdirSync(dir)){
      if(++scanned>20000)fail('bounded Metrics lookup exceeded');
      if(!/^[a-z0-9][a-z0-9._-]*\.json$/.test(name))
        fail('unsafe Metrics object name');
      // The canonical unique name is run-attempt-task. Do not inspect unrelated
      // model content, and never follow a symlink.
      if(!name.startsWith(run.id+'-'+run.run_attempt+'-'))continue;
      const full=path.join(dir,name),st=fs.lstatSync(full);
      if(!st.isFile()||st.isSymbolicLink()||st.size<2||st.size>1024*1024)
        fail('unsafe persisted Reviewer Metrics object');
      let record;
      try{record=JSON.parse(fs.readFileSync(full,'utf8'));}
      catch{fail('invalid persisted Reviewer Metrics JSON');}
      validateAgentWorkflowTelemetry(record);
      if(telemetryStoragePath(record)!==path.posix.join('raw','workflows',
          'agent-review',date,name)||
         record.identity.workflow_id!=='agent-review'||
         record.identity.github_run_id!==run.id||
         record.identity.github_run_attempt!==run.run_attempt)
        fail('unbound persisted Reviewer Metrics path');
      found.push(record);
    }
  }
  if(found.length!==1)fail('missing or duplicate canonical Reviewer Metrics witness');
  return found[0];
}
export function canonicalActionFromArtifacts(list,run){
  if(!Array.isArray(list?.artifacts)||list.total_count!==list.artifacts.length||
     list.artifacts.length>100)fail('incomplete result Artifact manifest');
  const pattern=new RegExp('^agent-result-'+run.id+'-'+run.run_attempt+'-([a-f0-9]{64})$');
  const matches=list.artifacts.map(x=>pattern.exec(x.name??'')).filter(Boolean);
  if(matches.length!==1)fail('missing or duplicate Reviewer Result action');
  return matches[0][1];
}
export function resolveReviewIngestSource({environment,event}){
  if(environment?.GITHUB_ACTIONS!=='true'||
     environment.GITHUB_REPOSITORY!==REPO||
     environment.GITHUB_REF!=='refs/heads/main'||
     environment.GITHUB_WORKFLOW!=='Store / Agent Review Result Ingest'||
     !HEX40.test(environment.GITHUB_SHA??'')||
     Number(environment.GITHUB_RUN_ATTEMPT)!==1)
    fail('not a trusted main-owned Ingest workflow');
  const dispatch=environment.GITHUB_EVENT_NAME==='repository_dispatch';
  const owner=environment.GITHUB_EVENT_NAME==='workflow_dispatch';
  if(event?.repository?.full_name!==REPO||!dispatch&&!owner||
     (dispatch&&(event.action!=='nession-review-metrics-ingested'||
       environment.GITHUB_ACTOR!=='github-actions[bot]'||
       event.sender?.login!=='github-actions[bot]'))||
     (owner&&environment.GITHUB_ACTOR!=='BestNathan'))
    fail('untrusted Review ingest event');
  const args=dispatch?event.client_payload:event.inputs;
  const id=Number(args?.source_run_id),attempt=Number(args?.source_run_attempt);
  if(!positive(id)||!positive(attempt)||attempt>10)
    fail('unbound Review source Run/attempt');
  if(dispatch&&!HEX40.test(args?.source_sha??''))
    fail('missing Metrics producer source SHA');
  return Object.freeze({run_id:id,attempt,expected_sha:dispatch?args.source_sha:null});
}
function existingResult(storeRoot,issue,run,actionId){
  const rel='workflows/issues/'+issue+'/results/'+run.id+'-'+run.run_attempt+'-'+actionId+'.json';
  const full=path.join(storeRoot,rel);
  if(!fs.existsSync(full))return null;
  const st=fs.lstatSync(full);
  if(!st.isFile()||st.isSymbolicLink()||st.size>65536)fail('unsafe committed Reviewer receipt');
  let value;
  try{value=JSON.parse(fs.readFileSync(full,'utf8'));}
  catch{fail('invalid committed Reviewer receipt');}
  validateAuthenticatedAgentReceipt(value);
  if(value.issue!==issue||value.action_id!==actionId||
     value.result.kind!=='reviewer'||value.result.run_id!==run.id||
     value.result.run_attempt!==run.run_attempt)
    fail('conflicting immutable Reviewer replay');
  return value;
}
export async function verifyReviewerForStore({storeRoot,metricsRoot,run,reader,
  artifactReader,keyring,registry,now=Date.now()}) {
  authenticateReviewerRun(run,run.id,run.run_attempt);
  const listing=await artifactReader.listRunArtifacts(run.id);
  const actionId=canonicalActionFromArtifacts(listing,run);
  const claim=await readAuthenticatedReviewClaim({artifactReader,run,action_id:actionId});
  const body=verifyDispatchTicket(claim.dispatch_ticket,keyring,{now,allowExpired:true});
  if(body.schema_version!==1||body.role!=='reviewer'||body.action_id!==actionId)
    fail('signed Reviewer claim mismatches Result action');
  const record=readIssueWorkflowState(storeRoot,body.issue);
  if(!record.state)fail('missing committed Issue Outbox state');
  const prior=existingResult(storeRoot,body.issue,run,actionId);
  const already=record.state.transitions.some(t=>t.kind==='reviewer'&&
    t.run_id===run.id&&t.attempt===run.run_attempt);
  if(already||prior){
    if(!already||!prior||prior.source.agent_id!==body.agent_id||
       prior.source.input_sha!==body.input_sha||
       prior.source.task_id!==body.action_id||
       !record.state.transitions.some(t=>t.kind==='reviewer'&&
         t.run_id===run.id&&t.attempt===run.run_attempt&&
         t.target_sha===prior.result.target_sha&&t.outcome===prior.result.outcome))
      fail('partial or conflicting reviewer replay');
    return {replayed:true,record,receipt:prior,intermediate:null,next:null};
  }
  const action=record.state.outbox.find(x=>x.id===actionId&&
    x.status==='dispatched'&&x.task.role==='reviewer'&&x.task.type==='dispatch');
  if(!action||action.task.agent_id!==body.agent_id||
     action.task.sha!==body.input_sha||
     record.state.assignments.reviewer!==body.agent_id||
     record.state.phase!=='review'||record.state.target_sha!==body.input_sha)
    fail('Result has no bound outstanding Reviewer action');
  let state=record.state,intermediate=null;
  if(action.receipt?.source_run_id!==run.id){
    const proof=await attestSkippedDispatchRebinding({
      state,action_id:actionId,skipped_run_id:action.receipt?.source_run_id,
      replacement_run_id:run.id,reader,artifactReader,keyring,
      verified_main_sha:run.head_sha,now,
    });
    intermediate=recordReboundDispatch(state,state.version,actionId,proof);
    state=intermediate; // Both versions publish in one Git CAS below.
  }
  const metrics=findReviewerMetrics(metricsRoot,run);
  const pr=metrics.task?.pr; // unprivileged candidate; attestAgentOutcome checks REST.
  if(!positive(pr))fail('canonical Reviewer Metrics lack reviewed PR number');
  const receipt=await ingestAgentResult({
    state,action_id:actionId,reader,artifactReader,registry,keyring,
    dispatch_ticket:claim.dispatch_ticket,pr_number:pr,
    verified_main_sha:run.head_sha,metrics,now,
  });
  const next=acceptTaskResult(state,state.version,
    receipt.result,receipt.source,registry);
  if(!['quality','repair','blocked'].includes(next.phase)||
     (receipt.result.outcome==='approved'&&next.phase!=='quality')||
     (receipt.result.outcome==='changes_requested'&&
       !['repair','blocked'].includes(next.phase)))
    fail('unexpected deterministic Reviewer transition');
  return {replayed:false,record,receipt,intermediate,next};
}
export function stageVerifiedReviewerStore({storeRoot,verified}) {
  if(verified.replayed)return {changed:false,version:verified.record.version};
  const {record,intermediate,next,receipt}=verified;
  const current=readIssueWorkflowState(storeRoot,receipt.issue);
  if(!current.state||current.version!==record.version||
     current.digest!==record.digest)
    fail('Store state changed since trusted Reviewer verification');
  if(intermediate)writeIssueWorkflowState(storeRoot,intermediate,record.version);
  writeIssueWorkflowState(storeRoot,next,intermediate?.version??record.version);
  const result=appendAuthenticatedResult(storeRoot,receipt);
  if(!result.changed)fail('Result path was already committed without transition');
  return {changed:true,version:next.version,phase:next.phase,
    outcome:receipt.result.outcome,action_id:receipt.action_id};
}
export function issueReceiptMarker(receipt) {
  validateAuthenticatedAgentReceipt(receipt);
  return '<!-- nession-review-result:v1:'+receipt.issue+':'+receipt.action_id+
    ':'+receipt.result.run_id+':'+receipt.result.run_attempt+' -->';
}
export function formatReviewerIssueReceipt(receipt,storeCommit,storeVersion){
  validateAuthenticatedAgentReceipt(receipt);
  if(receipt.result.kind!=='reviewer'||!HEX40.test(storeCommit??'')||
     !positive(storeVersion))fail('invalid Reviewer Issue projection');
  const approved=receipt.result.outcome==='approved';
  return [
    issueReceiptMarker(receipt),
    '## Authenticated Reviewer result',
    '',
    '- Verdict: \`'+receipt.result.outcome+'\`',
    '- Source: [Agent / Review run '+receipt.result.run_id+
      '](https://github.com/'+REPO+'/actions/runs/'+receipt.result.run_id+
      ') / attempt '+receipt.result.run_attempt,
    '- Signed Action: \`'+receipt.action_id+'\`',
    '- Reviewed PR: #'+receipt.implementing_pr.number+
      ' at \`'+receipt.result.target_sha+'\`',
    '- Committed Store: \`'+storeCommit+'\`, workflow state v'+storeVersion,
    '- Next deterministic step: '+(approved?
      'one pending Quality verification action':
      'the same assigned Developer repair action (or repair-limit block)'),
    '',
    'This is a committed orchestration receipt, not Acceptance Pass or merge authority.',
  ].join('\n');
}
// Issue comments are a projection after Store commit, never a source of state.
// A failed/ambiguous POST is handled by a later authenticated replay that
// re-reads all pages for the deterministic marker before attempting another POST.
export async function projectReviewerIssue({receipt,commit,version,token,
  fetchFn=fetch}) {
  if(typeof token!=='string'||token.length<8)fail('Issue projection token required');
  const marker=issueReceiptMarker(receipt);
  const api='https://api.github.com/repos/'+REPO+'/issues/'+receipt.issue+'/comments';
  const headers={Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
    'X-GitHub-Api-Version':'2022-11-28'};
  for(let page=1;page<=20;page++){
    const response=await fetchFn(api+'?per_page=100&page='+page,{headers});
    if(!response.ok)fail('Issue receipt read failed: '+response.status);
    const comments=await response.json();
    if(!Array.isArray(comments)||comments.length>100)fail('unsafe Issue comment page');
    if(comments.some(c=>c?.user?.login==='github-actions[bot]'&&
       typeof c.body==='string'&&c.body.includes(marker)))
      return {projected:false,already_present:true};
    if(comments.length<100)break;
    if(page===20)fail('Issue comments exceed bounded reconciliation');
  }
  const body=formatReviewerIssueReceipt(receipt,commit,version);
  const response=await fetchFn(api,{method:'POST',headers:{...headers,
    'Content-Type':'application/json'},body:JSON.stringify({body})});
  if(response.status!==201)fail('Issue receipt projection failed: '+response.status);
  return {projected:true,already_present:false};
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='ingest')
    fail('usage: ingest (trusted main-owned workflow only)');
  const env=process.env;
  const event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const requested=resolveReviewIngestSource({environment:env,event});
  const readToken=env.GH_TOKEN,remote=env.AGENT_STORE_CONTROLLER_REMOTE;
  if(typeof readToken!=='string'||readToken.length<8||
     !remote?.startsWith('https://x-access-token:')||
     !remote.endsWith('@github.com/'+REPO+'.git')||
     typeof env.STORE_WRITER_PRIVATE_KEY!=='string')
    fail('missing scoped trusted reader/Store writer authority');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-result-ingest-'));
  const key=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    const store=path.join(root,'agent-store'),metrics=path.join(root,'metrics');
    clone(remote,'agent-store',store);
    // The immutable Metrics witness is read through a different public ref.
    clone('https://github.com/'+REPO+'.git','metrics',metrics);
    const reader=createGitHubRunReader(readToken);
    const artifactReader=createGitHubResultArtifactReader(readToken);
    const run=await reader.getRun(requested.run_id);
    authenticateReviewerRun(run,requested.run_id,requested.attempt);
    if(requested.expected_sha&&requested.expected_sha!==run.head_sha)
      fail('Metrics wake source SHA does not match actual Reviewer Run');
    const registry=JSON.parse(fs.readFileSync(
      'automation/agents/registry.json','utf8'));
    const verified=await verifyReviewerForStore({
      storeRoot:store,metricsRoot:metrics,run,reader,artifactReader,registry,
      keyring:{'main-controller':key},
    });
    const staged=stageVerifiedReviewerStore({storeRoot:store,verified});
    let commit=git(store,['rev-parse','HEAD']);
    if(staged.changed){
      git(store,['add','-A']);
      const audited=auditStagedRunStore(store,'agent-store');
      if(audited.checked_changes!==(verified.intermediate?4:3))
        fail('Reviewer CAS must add only Result, state versions, and head');
      git(store,['-c','user.name=nession-agent-controller',
        '-c','user.email=nession-agent-controller@users.noreply.github.com',
        'commit','-m','agent-store: authenticate Reviewer result for Issue '+
          verified.receipt.issue]);
      const pushed=publish('agent-store',store,4);
      commit=pushed.commit_sha;
    }
    // Project only after the immutable Store CAS was published successfully.
    const projected=await projectReviewerIssue({
      receipt:verified.receipt,commit,version:staged.version,token:readToken,
    });
    console.log(JSON.stringify({status:staged.changed?'accepted':'replayed',
      issue:verified.receipt.issue,run_id:run.id,attempt:run.run_attempt,
      action_id:verified.receipt.action_id,outcome:verified.receipt.result.outcome,
      state_version:staged.version,store_commit_sha:commit,
      issue_projection:projected}));
  }finally{
    key.fill(0);
    fs.rmSync(root,{recursive:true,force:true});
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
