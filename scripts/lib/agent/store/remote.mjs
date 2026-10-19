// #1664 D2 — trusted publisher adapter for the existing checkpoint Store.
// This module does NOT authenticate a GitHub source Run by itself: caller must
// pass already-authenticated source identity and restrict its write credentials
// to the trusted main-owned ingester. Never execute it inside model tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ingestEncryptedCheckpoint, restoreEncryptedCheckpoint } from './ingest.mjs';
import { writeIssueWorkflowState } from '../orchestration/state-store.mjs';
import { auditStagedRunStore } from '../../../run-store-integrity.mjs';
import { publish as publishGitCAS } from '../../../run-store-cas-push.mjs';

const HEX40=/^[0-9a-f]{40}$/;
const REF='agent-store';
function fail(text){throw new Error('agent-store remote: '+text);}
function git(dir,args){
  try {
    return execFileSync('git',['-C',dir,...args],{
      encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,
      timeout:45000,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    }).trim();
  }catch(error){
    // In particular, never display stderr or origin URLs: the remote may use
    // a credential-bearing URL minted by a trusted isolated job.
    fail('git '+args[0]+' failed ('+(error.status??'unknown')+')');
  }
}
function cloneRoot(remote){
  if(typeof remote!=='string'||!remote.trim()||/\s/.test(remote))fail('remote URL required');
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-remote-'));
  const checkout=path.join(parent,'store');
  try {
    execFileSync('git',['clone','--no-tags','--single-branch','--branch',REF,'--',remote,checkout],{
      encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:8*1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    const branch=git(checkout,['symbolic-ref','--short','HEAD']);
    if(branch!==REF)fail('unexpected Store branch');
    return {parent,checkout};
  }catch(error){
    fs.rmSync(parent,{recursive:true,force:true});
    if(error.message?.startsWith('agent-store remote:'))throw error;
    fail('authenticated orphan ref unavailable: explicit bootstrap required');
  }
}
function commitCandidate(checkout,message){
  // Local Store helpers write to a disposable checkout, not to Git's index.
  // Explicitly stage before evaluating the canonical Run Store policy.
  git(checkout,['add','-A']);
  const staged=auditStagedRunStore(checkout,REF);
  if(staged.checked_changes===0)return false;
  git(checkout,['-c','user.name=nession-store-writer',
    '-c','user.email=nession-store-writer@users.noreply.github.com',
    'commit','-m',message]);
  const parent=git(checkout,['rev-parse','HEAD^']),head=git(checkout,['rev-parse','HEAD']);
  if(!HEX40.test(parent)||!HEX40.test(head))fail('invalid linear candidate');
  return true;
}
function validatedInput({source,expectedVersion,key}){
  if(source?.repository!=='BestNathan/nession'||
      !Number.isSafeInteger(source.run_id)||source.run_id<1||
      !Number.isSafeInteger(source.attempt)||source.attempt<1||
      !Number.isSafeInteger(expectedVersion)||expectedVersion<0||
      !Buffer.isBuffer(key)||key.length!==32)fail('invalid trusted source/version/key');
}
// The Store's immutable objects + mutable checkpoint head are one Git commit.
// A crash before push leaves only an isolated disposable checkout; a lost
// acknowledgement can be recovered by a subsequent byte-identical replay.
// Existing run-store-cas-push is the sole remote publisher (normal, no force).
export function publishEncryptedAgentCheckpoint({
  remote,source,sealed,registry,key,expectedVersion,
  workflowState=null,expectedWorkflowVersion=null,onCandidate=null,
}) {
  validatedInput({source,expectedVersion,key});
  if ((workflowState===null)!==(expectedWorkflowVersion===null)) {
    fail('workflow state and expected version must be supplied together');
  }
  if(workflowState!==null && (
      workflowState.issue!==source.issue||
      !Number.isSafeInteger(expectedWorkflowVersion)||expectedWorkflowVersion<0)) {
    fail('workflow state belongs to a different Issue or invalid CAS version');
  }
  const {checkout,parent}=cloneRoot(remote);
  try{
    const stage=ingestEncryptedCheckpoint(
      checkout,source,sealed,registry,key,expectedVersion);
    // Optional deterministic Workflow state is written to the *same* disposable
    // checkout before git add/commit. It cannot be independently acknowledged.
    const stateResult=workflowState===null?null:
      writeIssueWorkflowState(checkout,workflowState,expectedWorkflowVersion);
    if(stage.idempotent){
      if(stateResult?.changed)fail('partial replay would split checkpoint and Workflow state');
      return {replayed:true,version:stage.version,commit_sha:git(checkout,['rev-parse','HEAD'])};
    }
    if(!commitCandidate(checkout,
      'agent-store: checkpoint '+source.role+'/'+source.agent_id+'/'+source.issue+'/'+stage.version)) {
      fail('unexpected unchanged checkpoint candidate');
    }
    // Test-only injection point: allows a competitor to advance the same
    // remote ref between our candidate commit and the CAS push.
    if(onCandidate!==null){
      if(process.env.NODE_ENV!=='test')fail('candidate injection is test-only');
      onCandidate({checkout,stage});
    }
    const published=publishGitCAS(REF,checkout,4);
    if(!HEX40.test(published.commit_sha))fail('unverifiable remote commit');
    return {replayed:published.replayed,version:stage.version,
      workflow_version:stateResult?.version??null,
      commit_sha:published.commit_sha,attempts:published.attempt};
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
}
// Restore only within a trusted caller that keeps the AES key out of the
// model executor. The returned Buffer must be explicitly zeroed by its caller.
export function fetchEncryptedAgentCheckpoint({remote,identity,expected,key}){
  if(!Buffer.isBuffer(key)||key.length!==32)fail('invalid restore key');
  const {checkout,parent}=cloneRoot(remote);
  try{
    const result=restoreEncryptedCheckpoint(checkout,identity,expected,key);
    return {head:result.head,native_bytes:result.native_bytes,
      commit_sha:git(checkout,['rev-parse','HEAD'])};
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
}

// Validate the EXACT signed checkpoint commit against the currently reachable
// trusted orphan branch without requiring the AES restore key. Other Agent
// checkpoints may have advanced the branch since this commit; the selected
// identity's immutable head must still match, or resume fails closed.
// This only attests an encrypted Git object. Private-key decryption is still a
// separate trusted restore operation before the model executor starts.
export function verifyCommittedCheckpoint({
  remote,identity,commit_sha,version,ciphertext_sha256,
}) {
  if(!HEX40.test(commit_sha??'')||!Number.isSafeInteger(version)||version<1||
      !/^[a-f0-9]{64}$/.test(ciphertext_sha256??'')||
      !['developer','reviewer','acceptor'].includes(identity?.role)||
      !/^[a-z][a-z0-9-]{1,80}$/.test(identity?.agent_id??'')||
      !Number.isSafeInteger(identity?.issue)||identity.issue<1) {
    fail('invalid signed checkpoint commitment');
  }
  const {checkout,parent}=cloneRoot(remote);
  try {
    const headSha=git(checkout,['rev-parse','HEAD']);
    if(!HEX40.test(headSha))fail('invalid current Store SHA');
    git(checkout,['merge-base','--is-ancestor',commit_sha,headSha]);
    const prefix='roles/'+identity.role+'/'+identity.agent_id+'/issues/'+identity.issue;
    const location=prefix+'/checkpoints/'+String(version).padStart(8,'0')+'.json';
    const read=(rev,filename)=>{
      let raw;
      try{raw=git(checkout,['show',rev+':'+filename]);}
      catch{fail('checkpoint commitment object missing');}
      try{return JSON.parse(raw);}catch{fail('corrupt committed checkpoint object');}
    };
    const currentHead=read(headSha,prefix+'/head.json');
    const committedHead=read(commit_sha,prefix+'/head.json');
    if(currentHead.version!==version||currentHead.checkpoint_path!==location||
        currentHead.ciphertext_sha256!==ciphertext_sha256||
        committedHead.version!==version||committedHead.checkpoint_path!==location||
        committedHead.ciphertext_sha256!==ciphertext_sha256) {
      fail('checkpoint advanced or signed head mismatched');
    }
    const record=read(commit_sha,location);
    if(record.schema_version!==1||record.kind!=='encrypted_agent_checkpoint'||
        record.version!==version||record.path!==location||
        record.identity?.role!==identity.role||
        record.identity?.agent_id!==identity.agent_id||
        record.identity?.issue!==identity.issue||
        record.ciphertext_sha256!==ciphertext_sha256) {
      fail('signed checkpoint record mismatch');
    }
    return {store_ref:'refs/heads/'+REF,commit_sha,version,ciphertext_sha256,
      current_store_sha:headSha};
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
}
