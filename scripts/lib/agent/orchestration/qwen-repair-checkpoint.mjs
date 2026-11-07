// #2137: read-only trusted Qwen Repair origin. A model or Issue comment
// never chooses a checkpoint; the Store's independently committed Publisher
// Intent, native ciphertext, Run receipt and Reviewer transition do.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateDevelopmentState} from './outbox.mjs';
import {qwenCommittedPublisherIntent} from './qwen-reviewer-source.mjs';
import {readIssueWorkflowState} from './state-store.mjs';

const SHA=/^[0-9a-f]{40}$/,HEX=/^[0-9a-f]{64}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
function fail(reason){throw Error('trusted Qwen Repair origin: '+reason);}
function read(root,relative,max=16*1024*1024){
  const file=path.join(root,relative);
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)
    fail('missing or unsafe committed Store evidence: '+relative);
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{fail('invalid immutable Store JSON');}
}
function git(root,...args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:20000,
    stdio:['ignore','pipe','ignore'],
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',
      GIT_TERMINAL_PROMPT:'0'},maxBuffer:1024*1024,
  }).trim();}
  catch{fail('unable to attest committed Git checkpoint');}
}
export function attestQwenPublishedRepairCheckpoint({storeRoot,state,actionId}){
  validateDevelopmentState(state);
  if(!Number.isSafeInteger(state.issue)||!HEX.test(actionId??'')||
     state.phase!=='repair'||!SHA.test(state.target_sha??'')||
     state.assignments.developer!=='dev-qwen-01'||
     state.assignments.reviewer!=='review-qwen-01')
    fail('Qwen Review-to-Repair state missing');
  const actions=state.outbox.filter(x=>x.id===actionId&&
    x.status==='pending'&&x.task.type==='dispatch'&&
    x.task.role==='developer'&&x.task.task==='repair'&&
    x.task.agent_id==='dev-qwen-01'&&x.task.resume===true&&
    x.task.sha===state.target_sha);
  if(actions.length!==1||state.outbox.filter(x=>x.status==='pending'&&
      x.task.role==='developer').length!==1)
    fail('no unique pending Qwen repair Action');
  const last=state.transitions.at(-1);
  if(last?.kind!=='reviewer'||last.outcome!=='changes_requested'||
     last.target_sha!==state.target_sha||!positive(last.run_id)||
     last.attempt!==1)
    fail('no latest authenticated changes_requested Reviewer transition');
  const publishers=state.transitions.filter(x=>x.kind==='publisher'&&
    x.outcome==='published'&&x.target_sha===state.target_sha);
  if(publishers.length!==1||publishers[0].attempt!==1)
    fail('no unique published PR HEAD for Reviewer');
  const intent=qwenCommittedPublisherIntent({storeRoot,issue:state.issue,
    publisherRunId:publishers[0].run_id});
  if(intent.target_main_sha!==intent.source_sha||
     intent.source_sha===state.target_sha||
     !positive(intent.worker_run_id)||!positive(intent.checkpoint_version)||
     !SHA.test(intent.checkpoint_commit_sha??'')||
     !HEX.test(intent.checkpoint_ciphertext_sha256??''))
    fail('Qwen original Developer is not a separately committed published source');
  const prefix='roles/developer/dev-qwen-01/issues/'+state.issue;
  const checkpointPath=prefix+'/checkpoints/'+
    String(intent.checkpoint_version).padStart(8,'0')+'.json';
  const runPath=prefix+'/runs/'+intent.worker_run_id+'-1.json';
  const head=read(storeRoot,prefix+'/head.json',8192);
  const checkpoint=read(storeRoot,checkpointPath);
  const run=read(storeRoot,runPath,8192);
  if(head.version!==intent.checkpoint_version||
     head.checkpoint_path!==checkpointPath||
     head.ciphertext_sha256!==intent.checkpoint_ciphertext_sha256||
     checkpoint.schema_version!==1||
     checkpoint.kind!=='encrypted_agent_checkpoint'||
     checkpoint.version!==head.version||
     checkpoint.path!==checkpointPath||
     checkpoint.identity?.issue!==state.issue||
     checkpoint.identity.role!=='developer'||
     checkpoint.identity.agent_id!=='dev-qwen-01'||
     checkpoint.metadata?.provider!=='claude-code'||
     checkpoint.metadata.source_sha!==intent.worker_source_sha||
     !HEX.test(checkpoint.metadata.harness_digest??'')||
     checkpoint.ciphertext_sha256!==intent.checkpoint_ciphertext_sha256||
     run.schema_version!==1||run.kind!=='agent_checkpoint_run'||
     run.role!=='developer'||run.agent_id!=='dev-qwen-01'||
     run.issue!==state.issue||run.run_id!==intent.worker_run_id||
     run.attempt!==1||run.version!==head.version||
     run.source_sha!==intent.worker_source_sha||
     run.workflow!=='.github/workflows/agent-develop.yml'||
     !SHA.test(run.workflow_sha??'')||
     run.workflow_sha!==intent.worker_sha||
     run.checkpoint_path!==checkpointPath||
     run.ciphertext_sha256!==head.ciphertext_sha256||
     run.harness_digest!==checkpoint.metadata.harness_digest)
    fail('immutable Qwen native Run, head or checkpoint does not match Publisher Intent');
  const author=git(storeRoot,'log','-1','--format=%H','HEAD','--',checkpointPath);
  if(author!==intent.checkpoint_commit_sha||
     git(storeRoot,'rev-parse',author+':'+checkpointPath)!==
       git(storeRoot,'hash-object',checkpointPath))
    fail('ciphertext checkpoint differs from independently committed author');
  return Object.freeze({verified:true,
    checkpoint_version:intent.checkpoint_version,
    checkpoint_commit_sha:intent.checkpoint_commit_sha,
    ciphertext_sha256:intent.checkpoint_ciphertext_sha256,
    source_sha:intent.worker_source_sha,source_run_id:intent.worker_run_id});
}

// A Qwen Repair source is the immutable ORIGINAL published PR branch, not a
// model-provided ref or an arbitrary commit reachable from current main.
// The Controller uses this read-only proof immediately before signing a
// pending, committed cross-phase Repair Dispatch.
export function qwenRepairPublishedSource({storeRoot,issue,actionId,sha}){
  if(!Number.isSafeInteger(issue)||issue<1||
      !HEX.test(actionId??'')||!SHA.test(sha??''))
    fail('missing exact Qwen Repair source context');
  const {state}=readIssueWorkflowState(storeRoot,issue);
  if(!state||state.issue!==issue||state.target_sha!==sha)
    fail('Qwen Repair source differs from immutable Store State');
  const proof=attestQwenPublishedRepairCheckpoint({storeRoot,state,actionId});
  const item=state.outbox.find(x=>x.id===actionId);
  const expected={checkpoint_version:proof.checkpoint_version,
    checkpoint_commit_sha:proof.checkpoint_commit_sha,
    ciphertext_sha256:proof.ciphertext_sha256,
    source_sha:proof.source_sha,source_run_id:proof.source_run_id};
  if(JSON.stringify(item.task.repair_checkpoint)!==JSON.stringify(expected))
    fail('Qwen Repair origin not yet CAS-bound in Store');
  const published=state.transitions.filter(t=>t.kind==='publisher'&&
    t.outcome==='published'&&t.target_sha===sha);
  if(published.length!==1)
    fail('ambiguous Qwen Repair Publisher origin');
  const intent=qwenCommittedPublisherIntent({storeRoot,issue,
    publisherRunId:published[0].run_id});
  if(intent.checkpoint_commit_sha!==proof.checkpoint_commit_sha||
     intent.checkpoint_ciphertext_sha256!==proof.ciphertext_sha256||
     intent.worker_run_id!==proof.source_run_id||
     intent.worker_source_sha!==proof.source_sha||
     intent.target_main_sha!==intent.source_sha||
     intent.branch!=='agent/'+issue+'/qwen-'+intent.action_id.slice(0,16))
    fail('Qwen Repair branch not the authenticated original publication');
  return Object.freeze({branch:'refs/heads/'+intent.branch,
    base_sha:intent.target_main_sha,review_sha:sha,issue,
    repair_action_id:actionId,publisher_run_id:intent.publisher_run_id});
}
