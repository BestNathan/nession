// #2274: main-owned READ-ONLY Qwen Publisher admission. This is the only
// bridge from a signed unprivileged Developer patch into trusted Publisher
// bytes. No Store writer credential, GitHub POST or model call occurs here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState} from '../orchestration/state-store.mjs';
import {qwenCommittedPublisherIntent}
  from '../orchestration/qwen-reviewer-source.mjs';
import {validateQwenPublisherIntent} from './store-intent.mjs';
import {verifyWorkerClaimForAck} from '../orchestration/worker-reconcile.mjs';
import {authorizeWorkerFromStore} from '../orchestration/worker-preflight.mjs';
import {validateQwenDevelopmentCandidate}
  from '../orchestration/qwen-development-ingest-candidate.mjs';
import {readCommittedQwenRunReceipt}
  from '../orchestration/qwen-development-commit.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
import {preflightAgentPatch} from './patch-preflight.mjs';
import {assertQwenControlledPublisherSource}
  from '../orchestration/qwen-development-source.mjs';

const HEX=/^[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(s){throw Error('trusted Qwen Publisher source: '+s);}
export async function preflightTrustedQwenPublisher({
  remote,registry,run,claim,reader,rootKey,
  result,proof,ciphertext,sourceCheckout,targetMainSha=null,
}){
  if(!Buffer.isBuffer(rootKey)||rootKey.length!==32||
      !remote||typeof remote!=='string'||
      typeof sourceCheckout!=='string'||!sourceCheckout.startsWith('/')||
      !run||run.run_attempt!==1||
      !['implement'].includes(claim?.inputs?.task)||
      claim.inputs.agent_id!=='dev-qwen-01')
    fail('missing signed bounded Qwen Publisher request');
  // This verifies the HMAC ticket against the original owner/main issuer,
  // the exact completed bot-owned Worker Run and the original source SHA.
  const signed=await verifyWorkerClaimForAck({
    run,claim,key:rootKey,reader});
  const admission=authorizeWorkerFromStore({remote,registry,
    role:'developer',runId:run.id,input:claim.inputs});
  if(!admission.authorized||
      admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      signed.issue!==admission.issue||
      signed.action_id!==admission.action_id||
      signed.source_run_id!==admission.run_id)
    fail('signed Qwen Store ACK differs from authenticated source Run');
  // The Worker may have been dispatched at an earlier main ancestor. Publish
  // the authenticated patch onto the current main tree, but only after the
  // real old bytes/manifest and allowlist prove it still applies unchanged.
  const publisherBase=targetMainSha??admission.input_sha;
  if(!SHA.test(publisherBase??''))
    fail('invalid Publisher target main SHA');
  const candidate=validateQwenDevelopmentCandidate({
    admission,run,result,proof,ciphertext});
  const identity=candidate.identity;
  const checkpoint=readCommittedQwenRunReceipt(remote,identity,
    run,admission.action_id,admission.input_sha,candidate.metadata);
  if(!checkpoint||!positive(checkpoint.version)||!SHA.test(checkpoint.commit_sha)||
      !HEX.test(checkpoint.ciphertext_sha256))
    fail('missing exact immutable Qwen Store Run/checkpoint receipt');
  verifyCommittedCheckpoint({remote,identity,
    commit_sha:checkpoint.commit_sha,
    version:checkpoint.version,
    ciphertext_sha256:checkpoint.ciphertext_sha256});
  // The publisher never trusts the model's file list as an authorization
  // grant. It uses an existing protected-path owner, checks original Git
  // source, applies the real Git diff to an isolated disposable copy,
  // verifies actual file contents, and executes none of the source.
  const patch=Buffer.from(candidate.proposal.patch_base64,'base64').toString('utf8');
  const before=preflightAgentPatch({checkout:sourceCheckout,
    source_sha:publisherBase,patch,
    allowed_paths:candidate.proposal.changed_paths});
  // The Worker cannot authorize its own source scope. Independently
  // recheck the signed disposable Canary's exact bytes after Git applies
  // the real candidate patch, before any Store Intent or GitHub write.
  assertQwenControlledPublisherSource({issue:admission.issue,
    sourceCheckout,sourceSha:publisherBase,checked:before});
  const changed=before.files.map(file=>file.path).sort();
  if(before.source_sha!==publisherBase||
      before.patch_sha256!==candidate.proposal.patch_sha256||
      JSON.stringify(changed)!==JSON.stringify(candidate.proposal.changed_paths)||
      before.files.some(file=>file.operation==='create'))
    fail('applied source Git patch diverges from immutable Developer result');
  const evidence={schema_version:1,
    kind:'trusted_qwen_publisher_preflight_only',
    status:'preflight_only',
    issue:admission.issue,action_id:admission.action_id,
    worker_run_id:run.id,worker_run_attempt:run.run_attempt,
    worker_sha:run.head_sha,
    source_sha:publisherBase,
    worker_source_sha:admission.input_sha,
    checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
    harness_digest:candidate.metadata.harness_digest,
    native_session_id:candidate.metadata.session_id,
    agent_id:admission.agent_id,
    patch_sha256:before.patch_sha256,
    file_manifest:before.files};
  // The patch is allowed through ONLY as the previously authenticated exact
  // Worker Artifact, never a textual model response. Future Publisher
  // write-ahead intent may use this immutable verification without rerunning
  // Claude Code or granting the Worker GitHub write access.
  return Object.freeze({evidence,patch});
}


// #2137: Repair has a different authority boundary from a first PR:
// reviewed PR SHA A and the ORIGINAL Publisher Intent own the branch.
// A second model/Worker or fresh main HEAD can never select a new PR.
export function assertQwenRepairPublisherOrigin({
  state,admission,checkpoint,originalIntent,
}){
  const origin=admission?.resume_from;
  const intent=validateQwenPublisherIntent(originalIntent);
  if(!state||!Array.isArray(state.outbox)||
      !Array.isArray(state.transitions)||
      state.issue!==admission?.issue||state.phase!=='repair'||
      state.target_sha!==admission.input_sha||
      state.assignments?.developer!=='dev-qwen-01'||
      state.assignments?.reviewer!=='review-qwen-01'||
      admission.authorized!==true||
      admission.role!=='developer'||admission.task!=='repair'||
      admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      !SHA.test(admission.input_sha??'')||
      !HEX.test(admission.action_id??'')||
      !positive(admission.run_id))
    fail('Repair Publisher is not a signed same-Developer Review continuation');
  const actions=state.outbox.filter(x=>x.id===admission.action_id);
  if(actions.length!==1||actions[0].status!=='dispatched'||
      actions[0].task?.type!=='dispatch'||
      actions[0].task.role!=='developer'||
      actions[0].task.task!=='repair'||
      actions[0].task.agent_id!==admission.agent_id||
      actions[0].task.sha!==admission.input_sha||
      actions[0].task.resume!==true||
      actions[0].receipt?.status!=='verified'||
      actions[0].receipt.dispatch_id!==admission.action_id||
      actions[0].receipt.source_run_id!==admission.run_id||
      JSON.stringify(actions[0].task.repair_checkpoint)!==
        JSON.stringify(origin))
    fail('Repair Publisher lacks the exact committed dispatched Outbox source');
  const latest=state.transitions.at(-1);
  const prior=state.transitions.filter(x=>x.kind==='publisher'&&
    x.outcome==='published'&&x.target_sha===state.target_sha);
  if(latest?.kind!=='reviewer'||latest.outcome!=='changes_requested'||
      latest.target_sha!==state.target_sha||!positive(latest.run_id)||
      latest.attempt!==1||prior.length!==1||
      prior[0].run_id!==intent.publisher_run_id||
      prior[0].attempt!==1)
    fail('Repair Publisher lacks authentic last Review and original publication');
  if(!origin||!positive(origin.checkpoint_version)||
      !SHA.test(origin.checkpoint_commit_sha??'')||
      !HEX.test(origin.ciphertext_sha256??'')||
      !SHA.test(origin.source_sha??'')||!positive(origin.source_run_id)||
      intent.issue!==state.issue||
      intent.source_sha!==intent.target_main_sha||
      intent.source_sha===state.target_sha||
      intent.worker_source_sha!==origin.source_sha||
      intent.worker_run_id!==origin.source_run_id||
      intent.checkpoint_version!==origin.checkpoint_version||
      intent.checkpoint_commit_sha!==origin.checkpoint_commit_sha||
      intent.checkpoint_ciphertext_sha256!==origin.ciphertext_sha256||
      intent.branch!=='agent/'+state.issue+'/qwen-'+
        intent.action_id.slice(0,16)||
      !checkpoint||checkpoint.action_status!=='dispatched'||
      checkpoint.version!==origin.checkpoint_version+1||
      !SHA.test(checkpoint.commit_sha??'')||
      !HEX.test(checkpoint.ciphertext_sha256??''))
    fail('Repair native vN+1 is not bound to the original Qwen PR checkpoint');
  return Object.freeze({
    issue:state.issue,action_id:admission.action_id,
    review_sha:state.target_sha,branch:'refs/heads/'+intent.branch,
    original_main_sha:intent.target_main_sha,
    original_publisher_run_id:intent.publisher_run_id,
    original_developer_run_id:intent.worker_run_id,
    original_checkpoint_version:intent.checkpoint_version,
    repair_checkpoint_version:checkpoint.version,
    repair_checkpoint_commit_sha:checkpoint.commit_sha,
  });
}

// The Worker checked the signed *previous* checkpoint before its model ran.
// After the Repair Store Ingest commits vN+1, that old head is intentionally
// no longer current. DO NOT call authorizeWorkerFromStore here: its strict
// pre-model current-head check must not be weakened for a post-model reader.
// Reconstruct only a read-only Publisher admission from the signed Claim,
// committed dispatch receipt, original immutable source and Store history.
function readQwenRepairPublisherAdmission({remote,registry,run,claim,signed}){
  if(typeof remote!=='string'||(!remote.startsWith('https://x-access-token:')&&
      !(process.env.NODE_ENV==='test'&&path.isAbsolute(remote))))
    fail('Repair Publisher requires the scoped authenticated Store source');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-repair-publisher-source-'));
  try{
    const dir=path.join(tmp,'agent-store');
    try{
      execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
        '--branch','agent-store','--',remote,dir],{
        timeout:45000,stdio:['ignore','pipe','pipe'],
        env:{...process.env,GIT_TERMINAL_PROMPT:'0',
          GIT_NO_REPLACE_OBJECTS:'1'}});
    }catch{fail('Repair Publisher cannot read authenticated agent-store');}
    const state=readIssueWorkflowState(dir,signed.issue).state;
    const actions=state?.outbox?.filter(x=>x.id===signed.action_id);
    const action=actions?.length===1?actions[0]:null;
    const origin=action?.task?.repair_checkpoint;
    const registered=registry?.instances?.[claim.inputs.agent_id];
    const canonical=x=>JSON.stringify(Object.fromEntries(
      Object.keys(x).sort().map(k=>[k,x[k]])));
    if(state?.issue!==signed.issue||state.phase!=='repair'||
        state.target_sha!==claim.inputs.input_sha||
        state.assignments?.developer!=='dev-qwen-01'||
        state.assignments?.reviewer!=='review-qwen-01'||
        actions.length!==1||action.status!=='dispatched'||
        action.task?.type!=='dispatch'||action.task.role!=='developer'||
        action.task.task!=='repair'||action.task.agent_id!=='dev-qwen-01'||
        action.task.sha!==claim.inputs.input_sha||
        action.task.resume!==true||
        action.receipt?.status!=='verified'||
        action.receipt.dispatch_id!==signed.action_id||
        action.receipt.source_run_id!==run.id||
        claim.inputs.task!=='repair'||
        claim.inputs.agent_id!=='dev-qwen-01'||
        Number(claim.inputs.issue_number)!==signed.issue||
        claim.inputs.action_id!==signed.action_id||
        !origin||!positive(origin.checkpoint_version)||
        !SHA.test(origin.checkpoint_commit_sha??'')||
        !HEX.test(origin.ciphertext_sha256??'')||
        !SHA.test(origin.source_sha??'')||
        !positive(origin.source_run_id)||
        claim.inputs.resume_from!==
          Buffer.from(canonical(origin)).toString('base64url')||
        registered?.role!=='developer'||
        registered.provider!=='claude-code'||
        registered.environment!=='dev-claude-qwen')
      fail('post-commit Repair Publisher lacks authenticated signed Outbox');
    const published=state.transitions.filter(x=>x.kind==='publisher'&&
      x.outcome==='published'&&x.target_sha===state.target_sha);
    if(published.length!==1||!positive(published[0].run_id))
      fail('Repair Publisher has no unique original GitHub publication');
    const originalIntent=qwenCommittedPublisherIntent({storeRoot:dir,
      issue:signed.issue,publisherRunId:published[0].run_id});

    // The original vN is historical after vN+1. Verify its immutable
    // Git object and author commit, NOT the new current identity head.
    const prefix='roles/developer/dev-qwen-01/issues/'+signed.issue;
    const location=prefix+'/checkpoints/'+String(origin.checkpoint_version)
      .padStart(8,'0')+'.json';
    const filePath=path.join(dir,location);
    const stat=fs.lstatSync(filePath,{throwIfNoEntry:false});
    if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)
      fail('missing or unsafe historic Qwen checkpoint');
    const git=(...args)=>{
      try{return execFileSync('git',['-C',dir,...args],{
        encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000,
        maxBuffer:1024*1024,env:{...process.env,
          GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'}}).trim();}
      catch{fail('historical Qwen Git checkpoint is not reachable');}
    };
    git('merge-base','--is-ancestor',origin.checkpoint_commit_sha,'HEAD');
    if(git('rev-parse',origin.checkpoint_commit_sha+':'+location)!==
       git('hash-object',location))
      fail('historic native bytes differ from committed origin');
    let oldCheckpoint,oldHead;
    try{
      oldCheckpoint=JSON.parse(fs.readFileSync(filePath,'utf8'));
      oldHead=JSON.parse(git('show',origin.checkpoint_commit_sha+':'+
        prefix+'/head.json'));
    }catch{fail('corrupt historical Qwen native source');}
    if(oldHead.version!==origin.checkpoint_version||
        oldHead.checkpoint_path!==location||
        oldHead.ciphertext_sha256!==origin.ciphertext_sha256||
        oldCheckpoint.version!==origin.checkpoint_version||
        oldCheckpoint.schema_version!==1||
        oldCheckpoint.kind!=='encrypted_agent_checkpoint'||
        oldCheckpoint.ciphertext_sha256!==origin.ciphertext_sha256||
        oldCheckpoint.identity?.role!=='developer'||
        oldCheckpoint.identity.agent_id!=='dev-qwen-01'||
        oldCheckpoint.identity.issue!==signed.issue||
        oldCheckpoint.metadata?.provider!=='claude-code'||
        oldCheckpoint.metadata.source_sha!==origin.source_sha||
        !HEX.test(oldCheckpoint.metadata.harness_digest??'')||
        !oldCheckpoint.metadata.session_id)
      fail('historical original native checkpoint source is invalid');
    const admission=Object.freeze({authorized:true,issue:signed.issue,
      role:'developer',agent_id:'dev-qwen-01',provider:'claude-code',
      environment:'dev-claude-qwen',task:'repair',
      action_id:signed.action_id,run_id:run.id,
      input_sha:claim.inputs.input_sha,resume_from:origin});
    return {admission,state,originalIntent,oldMetadata:oldCheckpoint.metadata};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}

// A standalone credential-free PATCH verifier for a future same-PR
// non-force Publisher. The existing first-PR publish path remains strictly
// implement-only and cannot accidentally issue a second PR for Repair.
export async function preflightTrustedQwenRepairPublisher({
  remote,registry,run,claim,reader,rootKey,
  result,proof,ciphertext,sourceCheckout,
}){
  if(!Buffer.isBuffer(rootKey)||rootKey.length!==32||
      typeof sourceCheckout!=='string'||!path.isAbsolute(sourceCheckout)||
      run?.run_attempt!==1||claim?.inputs?.task!=='repair'||
      claim.inputs.agent_id!=='dev-qwen-01')
    fail('Repair Publisher requires an exact signed native Repair Run');
  const signed=await verifyWorkerClaimForAck({
    run,claim,key:rootKey,reader});
  const bound=readQwenRepairPublisherAdmission({
    remote,registry,run,claim,signed});
  const {admission}=bound;
  const candidate=validateQwenDevelopmentCandidate({
    admission,run,result,proof,ciphertext});
  if(candidate.metadata.session_id!==bound.oldMetadata.session_id||
      candidate.metadata.harness_digest!==bound.oldMetadata.harness_digest)
    fail('Repair native UUID/Harness differs from original committed Session');
  const checkpoint=readCommittedQwenRunReceipt(remote,candidate.identity,
    run,admission.action_id,admission.input_sha,candidate.metadata,'repair');
  if(!checkpoint||!positive(checkpoint.version)||
      !SHA.test(checkpoint.commit_sha)||!HEX.test(checkpoint.ciphertext_sha256))
    fail('Repair Publisher requires committed native vN+1 Run receipt');
  verifyCommittedCheckpoint({remote,identity:candidate.identity,
    commit_sha:checkpoint.commit_sha,version:checkpoint.version,
    ciphertext_sha256:checkpoint.ciphertext_sha256});
  const origin=assertQwenRepairPublisherOrigin({
    state:bound.state,admission,checkpoint,
    originalIntent:bound.originalIntent});
  const patch=Buffer.from(candidate.proposal.patch_base64,'base64')
    .toString('utf8');
  const checked=preflightAgentPatch({checkout:sourceCheckout,
    source_sha:admission.input_sha,patch,
    allowed_paths:candidate.proposal.changed_paths});
  // A deliberately one-line bounded canary must not be broadened into
  // arbitrary "repair" edits to manufacture Reviewer changes_requested.
  assertQwenControlledPublisherSource({issue:admission.issue,
    sourceCheckout,sourceSha:admission.input_sha,checked});
  const changed=checked.files.map(x=>x.path).sort();
  if(checked.source_sha!==origin.review_sha||
      checked.patch_sha256!==candidate.proposal.patch_sha256||
      JSON.stringify(changed)!==
        JSON.stringify(candidate.proposal.changed_paths)||
      checked.files.some(x=>x.operation==='create'))
    fail('Repair patch is not a tracked exact PR SHA-A edit');
  return Object.freeze({patch,origin,evidence:Object.freeze({
    schema_version:1,kind:'trusted_qwen_repair_preflight_only',
    status:'preflight_only',issue:admission.issue,
    action_id:admission.action_id,developer_run_id:run.id,
    worker_sha:run.head_sha,source_sha:admission.input_sha,
    original_pr_branch:origin.branch,
    original_main_sha:origin.original_main_sha,
    original_publisher_run_id:origin.original_publisher_run_id,
    checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
    native_session_id:candidate.metadata.session_id,
    harness_digest:candidate.metadata.harness_digest,
    patch_sha256:checked.patch_sha256,file_manifest:checked.files,
  })});
}
