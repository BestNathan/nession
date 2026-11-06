// #2137: read-only trusted Qwen Repair origin. A model or Issue comment
// never chooses a checkpoint; the Store's independently committed Publisher
// Intent, native ciphertext, Run receipt and Reviewer transition do.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateDevelopmentState} from './outbox.mjs';
import {qwenCommittedPublisherIntent} from './qwen-reviewer-source.mjs';

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
     checkpoint.metadata.source_sha!==intent.source_sha||
     !HEX.test(checkpoint.metadata.harness_digest??'')||
     checkpoint.ciphertext_sha256!==intent.checkpoint_ciphertext_sha256||
     run.schema_version!==1||run.kind!=='agent_checkpoint_run'||
     run.role!=='developer'||run.agent_id!=='dev-qwen-01'||
     run.issue!==state.issue||run.run_id!==intent.worker_run_id||
     run.attempt!==1||run.version!==head.version||
     run.source_sha!==intent.source_sha||
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
    source_sha:intent.source_sha,source_run_id:intent.worker_run_id});
}
