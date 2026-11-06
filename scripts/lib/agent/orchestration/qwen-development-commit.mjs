// #2274: trusted, main-owned Qwen Developer candidate -> existing Store CAS
// and signed Outbox yield. No model, raw prompt, Publisher or PR writer here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyWorkerClaimForAck} from './worker-reconcile.mjs';
import {authorizeWorkerFromStore} from './worker-preflight.mjs';
import {validateQwenDevelopmentCandidate,sealQwenCandidateForStore}
  from './qwen-development-ingest-candidate.mjs';
import {readCheckpointHeadVersion,publishEncryptedAgentCheckpoint,
  verifyCommittedCheckpoint,readCommittedCheckpoint,
  fetchEncryptedAgentCheckpoint} from '../store/remote.mjs';
import {readIssueWorkflowState} from './state-store.mjs';

const SHA=/^[a-f0-9]{40}$/;
const HEX=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(message){throw Error('trusted Qwen Developer ingest: '+message);}
function safeOrigin(run,claim,authenticated){
  const inputs=claim?.inputs;
  if(!run||run.run_attempt!==1||run.status!=='completed'||
      run.conclusion!=='success'||run.path!=='.github/workflows/agent-develop.yml'||
      run.name!=='Agent / Development'||run.head_branch!=='main'||
      run.actor?.login!=='github-actions[bot]'||
      run.repository?.full_name!=='BestNathan/nession'||
      run.head_repository?.full_name!=='BestNathan/nession'||
      !SHA.test(run.head_sha??'')||
      inputs?.agent_id!=='dev-qwen-01'||
      !['implement','repair'].includes(inputs.task)||
      authenticated?.issue!==Number(inputs.issue_number)||
      authenticated.action_id!==inputs.action_id||
      authenticated.source_run_id!==run.id||
      authenticated.attempt!==run.run_attempt)
    fail('untrusted Qwen Run or signed Developer action');
  return {role:'developer',agent_id:'dev-qwen-01',
    issue:Number(inputs.issue_number)};
}
function git(...args){
  try{return execFileSync('git',args,{encoding:'utf8',
    stdio:['ignore','pipe','pipe'],timeout:45000,
    maxBuffer:16*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',
      GIT_NO_REPLACE_OBJECTS:'1'}}).trim();}
  catch{fail('read-only authenticated Store access failed');}
}
export function readCommittedQwenRunReceipt(remote,identity,run,admissionAction,
  admissionSource,expected,task='implement'){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-store-reader-'));
  try{
    const dir=path.join(home,'store');
    git('clone','--no-tags','--single-branch','--branch','agent-store','--',
      remote,dir);
    const record=readIssueWorkflowState(dir,identity.issue);
    const action=record.state?.outbox.find(item=>item.id===admissionAction);
    if(record.state?.assignments?.developer!==identity.agent_id||
       !action||!['dispatched','yielded'].includes(action.status)||
       action.task?.role!=='developer'||action.task?.task!==task||
       (task==='repair'&&(record.state.phase!=='repair'||
         record.state.target_sha!==admissionSource||
         action.task.resume!==true||!action.task.repair_checkpoint))||
       action.task?.agent_id!==identity.agent_id||
       action.task?.sha!==admissionSource||
       action.receipt?.source_run_id!==run.id||
       action.receipt?.dispatch_id!==admissionAction)
      fail('replayed Qwen checkpoint not bound to current Store Outbox');
    const prefix='roles/developer/'+identity.agent_id+'/issues/'+identity.issue;
    const location=prefix+'/runs/'+run.id+'-'+run.run_attempt+'.json';
    const file=path.join(dir,location);
    if(!fs.existsSync(file))return null;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)
      fail('unsafe immutable Qwen checkpoint receipt');
    const receipt=JSON.parse(fs.readFileSync(file,'utf8'));
    if(receipt.role!=='developer'||receipt.agent_id!==identity.agent_id||
        receipt.issue!==identity.issue||receipt.run_id!==run.id||
        receipt.attempt!==run.run_attempt||
        receipt.source_sha!==admissionSource||
        receipt.workflow_sha!==run.head_sha||
        receipt.harness_digest!==expected.harness_digest||
        !Number.isSafeInteger(receipt.version)||receipt.version<1||
        !/^([a-f0-9]{64})$/.test(receipt.ciphertext_sha256??'')||
        receipt.checkpoint_path!==prefix+'/checkpoints/'+
          String(receipt.version).padStart(8,'0')+'.json')
      fail('conflicting immutable Qwen checkpoint receipt');
    const cp=JSON.parse(fs.readFileSync(
      path.join(dir,receipt.checkpoint_path),'utf8'));
    if(cp.version!==receipt.version||
       cp.ciphertext_sha256!==receipt.ciphertext_sha256||
       cp.metadata?.provider!=='claude-code'||
       cp.metadata?.source_sha!==admissionSource||
       cp.metadata?.harness_digest!==expected.harness_digest||
       cp.metadata?.session_id!==expected.session_id)
      fail('ciphertext checkpoint does not match exact Qwen Run result');
    const commit_sha=git('-C',dir,'log','-1','--format=%H','HEAD',
      '--',receipt.checkpoint_path);
    if(!SHA.test(commit_sha))fail('immutable Qwen checkpoint commit missing');
    return {version:receipt.version,commit_sha,
      ciphertext_sha256:receipt.ciphertext_sha256,
      action_status:action.status};
  }finally{fs.rmSync(home,{recursive:true,force:true});}
}
function sourceForStore(run,admission){
  return {repository:'BestNathan/nession',run_id:run.id,
    attempt:run.run_attempt,issue:admission.issue,workflow_sha:run.head_sha,
    target_sha:admission.input_sha,head_branch:'main',
    path:run.path,workflow_name:run.name,role:'developer',
    agent_id:'dev-qwen-01',task:admission.task,
    environment:'dev-claude-qwen',provider:'claude-code',event:run.event};
}
// Pure, testable version gate BEFORE expensive RSA or any Store mutation.
// The current Store head is also rechecked in publishEncryptedAgentCheckpoint.
export function qwenCheckpointNextVersion(admission,head){
  if(admission?.authorized!==true||admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||admission.role!=='developer'||
      !['implement','repair'].includes(admission.task)||
      !Number.isSafeInteger(head?.version)||
      head.version<0)fail('unauthorized Qwen checkpoint version request');
  const origin=admission.resume_from;
  const previous=origin?.checkpoint_version??0;
  if(admission.task==='repair'&&(
       !origin||!positive(previous)||!SHA.test(origin.checkpoint_commit_sha??'')||
       !HEX.test(origin.ciphertext_sha256??'')||
       !SHA.test(origin.source_sha??'')||
       origin.source_sha===admission.input_sha||
       !positive(origin.source_run_id)))
    fail('repair requires signed compatible previous native checkpoint');
  if(!Number.isSafeInteger(previous)||previous<0||head.version!==previous)
    fail('Qwen Store head advanced or does not match signed continuation');
  return previous+1;
}
// Requires the exact GitHub Run and BOTH original Artifact ZIP digests to have
// been verified in the existing development-ingest.mjs entrypoint before use.
export async function ingestQwenVerifiedCandidate({
  remote,registry,run,claim,reader,rootKey,aesKey,privateKeyPem,
  result,proof,ciphertext,
}){
  if(!Buffer.isBuffer(rootKey)||rootKey.length!==32||
      !Buffer.isBuffer(aesKey)||aesKey.length!==32||
      !(remote?.startsWith('https://x-access-token:')||
        (process.env.NODE_ENV==='test'&&path.isAbsolute(remote)))||
      typeof privateKeyPem!=='string'||privateKeyPem.length<100)
    fail('missing isolated trusted Store and native decryption authority');
  const authenticated=await verifyWorkerClaimForAck({
    run,claim,key:rootKey,reader});
  const identity=safeOrigin(run,claim,authenticated);
  const expected={session_id:proof?.metadata?.session_id,
    harness_digest:proof?.metadata?.harness_digest};
  const previous=readCommittedQwenRunReceipt(remote,identity,run,
    claim.inputs.action_id,claim.inputs.input_sha,expected,claim.inputs.task);
  // The public Artifact contents alone have no authority; cryptographic
  // claim verification and immutable Store admission precede version CAS.
  let admission;
  if(previous){
    const bound=validateQwenDevelopmentCandidate({
      admission:{authorized:true,role:'developer',
        agent_id:identity.agent_id,issue:identity.issue,
        action_id:claim.inputs.action_id,input_sha:claim.inputs.input_sha,
        run_id:run.id,provider:'claude-code',environment:'dev-claude-qwen',
        task:claim.inputs.task,
        ...(claim.inputs.resume_from?{resume_from:true}:{})},
      run,result,proof,ciphertext});
    if(bound.metadata.session_id!==expected.session_id)
      fail('replayed native UUID differs from immutable Store checkpoint');
    // A signed Run/Artifact may be re-read, but it cannot propose a different
    // ciphertext or patch under the same immutable Store Run receipt. Compare
    // the original RSA-encrypted envelope while holding Store AES authority;
    // no native plaintext or model messages are rehydrated or logged.
    const original=fetchEncryptedAgentCheckpoint({remote,identity,
      expected:{provider:'claude-code',source_sha:claim.inputs.input_sha,
        harness_digest:bound.metadata.harness_digest},
      key:aesKey,commitment:{commit_sha:previous.commit_sha,
        version:previous.version,
        ciphertext_sha256:previous.ciphertext_sha256}});
    try{
      let committed;
      try{committed=JSON.parse(original.native_bytes.toString('utf8'));}
      catch{fail('invalid committed Qwen native replay envelope');}
      if(committed?.kind!=='qwen-claude-native-envelope'||
         committed.patch_sha256!==bound.proposal.patch_sha256||
         committed.rsa_envelope?.ciphertext_sha256!==
           ciphertext.ciphertext_sha256||
         committed.metadata?.session_id!==bound.metadata.session_id)
        fail('Qwen replay differs from immutable native ciphertext or patch');
    }finally{original.native_bytes.fill(0);}

    // The proposed patch is ready for the trusted Publisher, not another
    // model Slice. A crash after checkpoint CAS is a byte-identical replay;
    // NEVER generate a continuation action or repeat a Provider call.
    return {status:'replayed',issue:identity.issue,
      action_id:authenticated.action_id,checkpoint:previous};
  }
  admission=authorizeWorkerFromStore({remote,registry,role:'developer',
    runId:run.id,input:claim.inputs});
  if(admission.issue!==identity.issue||admission.action_id!==authenticated.action_id||
      admission.agent_id!==identity.agent_id)
    fail('independent Store admission differs from signed source');
  const bound=validateQwenDevelopmentCandidate({
    admission,run,result,proof,ciphertext});
  const head=readCheckpointHeadVersion({remote,identity});
  const nextVersion=qwenCheckpointNextVersion(admission,head);
  if(admission.task==='repair'){
    // The original encrypted native checkpoint is already committed and
    // pinned by the authenticated Store Action. A new model response may
    // not introduce a different Claude Code native Session UUID/model
    // harness or silently replace an unavailable checkpoint.
    const native=readCommittedCheckpoint({remote,identity,
      commit_sha:admission.resume_from.checkpoint_commit_sha,
      version:admission.resume_from.checkpoint_version,
      ciphertext_sha256:admission.resume_from.ciphertext_sha256});
    if(native.metadata?.provider!=='claude-code'||
       native.metadata.source_sha!==admission.resume_from.source_sha||
       native.metadata.harness_digest!==bound.metadata.harness_digest||
       native.metadata.session_id!==bound.metadata.session_id)
      fail('repair native Session UUID or source differs from committed original');
  }
  const {sealed}=sealQwenCandidateForStore({
    admission,run,result,proof,ciphertext,privateKeyPem,
    storeKey:aesKey,nextVersion});
  const published=publishEncryptedAgentCheckpoint({remote,
    source:sourceForStore(run,admission),sealed,registry,
    key:aesKey,expectedVersion:head.version});
  const checkpoint={version:published.version,
    commit_sha:published.commit_sha,
    ciphertext_sha256:sealed.ciphertext_sha256,
    run_id:run.id,attempt:run.run_attempt};
  // The signed Developer Action remains dispatched. Initial implement
  // may go to the trusted create-PR Publisher; a repair must instead
  // update its existing independently attested PR under a separate fence.
  // Checkpoint ingest never publishes a PR or synthesizes a Reviewer.
  return {status:published.replayed?'replayed':'committed',
    issue:admission.issue,action_id:authenticated.action_id,
    checkpoint,store_commit_sha:published.commit_sha};
}
