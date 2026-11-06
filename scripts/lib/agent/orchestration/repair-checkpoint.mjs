// #1997: immutable published-PR Repair origin. This is a read-only trusted
// Store inspector, not a second state machine or a model-selected checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateDevelopmentState} from './outbox.mjs';
import {issueStatePath} from './state-store.mjs';

const ISSUE=1997;
const ACTION='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const WORKER=39448549052;
const PRE_PUBLISH_STATE=16;
const PREFIX='roles/developer/dev-cursor-01/issues/1997';
const SHA=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
function reject(s){throw Error('trusted Repair checkpoint: '+s);}
function read(root,relative,max=16*1024*1024){
  const filename=path.join(root,relative),st=fs.lstatSync(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>max)
    reject('invalid immutable Store object '+relative);
  return JSON.parse(fs.readFileSync(filename,'utf8'));
}
function git(root,args){
  try{return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000,
    maxBuffer:1024*1024,
    env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0'},
  }).trim();}
  catch{reject('cannot authenticate checkpoint Git object');}
}
// Pure policy: require a real, completed pre-publication Developer yield and
// the exact same persisted encrypted checkpoint. The previous Outbox was
// legitimately pruned at Publisher handoff; never fake a yielded parent.
export function attestCrossPhaseRepairFacts({
  current,historical,head,checkpoint,run,checkpointCommitSha,actionId=ACTION,
}){
  validateDevelopmentState(current);
  validateDevelopmentState(historical);
  if(current.issue!==ISSUE||current.phase!=='repair'||
     current.version<22||current.target_sha==null||
     actionId!==ACTION||historical.issue!==ISSUE||
     historical.version!==PRE_PUBLISH_STATE||
     !SHA.test(checkpointCommitSha??''))
    reject('not the controlled published-PR Repair origin');
  const repair=current.outbox.filter(x=>x.id===actionId&&
    x.status==='pending'&&x.task.role==='developer'&&
    x.task.task==='repair'&&x.task.resume===true&&
    x.task.agent_id==='dev-cursor-01'&&x.task.sha===current.target_sha);
  const publication=current.transitions.find(x=>x.kind==='publisher'&&
    x.outcome==='published'&&x.target_sha===current.target_sha);
  const requested=current.transitions.find(x=>x.kind==='reviewer'&&
    x.outcome==='changes_requested'&&x.target_sha===current.target_sha);
  if(repair.length!==1||!publication||!requested||
     current.outbox.filter(x=>x.status==='pending'&&
       x.task.role==='developer').length!==1)
    reject('no unique authenticated Review-to-Repair handoff');
  const yieldAction=historical.outbox.find(x=>
    x.status==='yielded'&&x.task.role==='developer'&&
    x.task.agent_id==='dev-cursor-01'&&
    x.receipt?.source_run_id===WORKER&&x.receipt?.source_attempt===1&&
    x.receipt?.checkpoint_version===3);
  if(!yieldAction||!SHA.test(yieldAction.task.sha??'')||
     yieldAction.task.sha===current.target_sha||yieldAction.task.task!=='implement')
    reject('missing original trusted Developer yield');
  const receipt=yieldAction.receipt;
  const cpPath=PREFIX+'/checkpoints/00000003.json';
  if(head?.version!==3||head.checkpoint_path!==cpPath||
     head.ciphertext_sha256!==receipt.ciphertext_sha256||
     checkpoint?.schema_version!==1||
     checkpoint.kind!=='encrypted_agent_checkpoint'||
     checkpoint.path!==cpPath||checkpoint.version!==3||
     checkpoint.identity?.role!=='developer'||
     checkpoint.identity?.agent_id!=='dev-cursor-01'||
     checkpoint.identity?.issue!==ISSUE||
     checkpoint.metadata?.provider!=='cursor'||
     !/^agent-[a-zA-Z0-9-]{4,100}$/.test(checkpoint.metadata?.session_id??'')||
     !HEX64.test(checkpoint.metadata?.harness_digest??'')||
     checkpoint.metadata.source_sha!==yieldAction.task.sha||
     checkpoint.ciphertext_sha256!==receipt.ciphertext_sha256||
     receipt.checkpoint_commit_sha!==checkpointCommitSha)
    reject('encrypted native checkpoint or historical yield changed');
  if(run?.schema_version!==1||run.kind!=='agent_checkpoint_run'||
     run.role!=='developer'||run.agent_id!=='dev-cursor-01'||
     run.issue!==ISSUE||run.run_id!==WORKER||run.attempt!==1||
     run.version!==3||run.source_sha!==yieldAction.task.sha||
     run.workflow!=='.github/workflows/agent-develop.yml'||
     !SHA.test(run.workflow_sha??'')||
     run.checkpoint_path!==cpPath||
     run.ciphertext_sha256!==receipt.ciphertext_sha256||
     run.harness_digest!==checkpoint.metadata.harness_digest)
    reject('historical Run is not the checkpoint author');
  return Object.freeze({verified:true,checkpoint_version:3,
    checkpoint_commit_sha:checkpointCommitSha,
    ciphertext_sha256:receipt.ciphertext_sha256,
    source_sha:yieldAction.task.sha,source_run_id:WORKER});
}
// Caller uses a freshly cloned, audited agent-store ref and commits through
// the existing Store CAS only AFTER this readback; never accepts Issue/model
// supplied checkpoint paths or sha/digest fields.
export function readPublishedRepairCheckpoint(storeRoot,current,actionId=ACTION){
  const historical=read(storeRoot,issueStatePath(ISSUE,PRE_PUBLISH_STATE),512*1024);
  const head=read(storeRoot,PREFIX+'/head.json',8192);
  const checkpointPath=PREFIX+'/checkpoints/00000003.json';
  const checkpoint=read(storeRoot,checkpointPath);
  const run=read(storeRoot,PREFIX+'/runs/'+WORKER+'-1.json',16384);
  const checkpointCommitSha=git(storeRoot,
    ['log','-1','--format=%H','HEAD','--',checkpointPath]);
  if(!SHA.test(checkpointCommitSha))reject('historical checkpoint commit absent');
  const historicalBlob=git(storeRoot,['rev-parse',
    checkpointCommitSha+':'+checkpointPath]);
  const currentBlob=git(storeRoot,['hash-object',checkpointPath]);
  if(historicalBlob!==currentBlob)reject('checkpoint bytes differ from original commit');
  return attestCrossPhaseRepairFacts({
    current,historical,head,checkpoint,run,checkpointCommitSha,actionId,
  });
}
