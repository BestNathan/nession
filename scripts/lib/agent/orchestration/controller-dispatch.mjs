#!/usr/bin/env node
// #2010. Authenticated main-owned dispatch driver. This process owns the
// Store CAS writer and Actions dispatch token. NEVER run from a Provider,
// untrusted checkout, PR head, model tool or Developer environment.
import fs from 'node:fs';
import {hkdfSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {executeDurableAgentDispatch,recoverConfirmedFailedDeveloperDispatch,
  recoverAttestedNativeResumeFailure,executeControlledReviewerRecovery} from './dispatch-store.mjs';
import {failedDeveloperRetryActionId,nativeResumeSuccessorId} from './outbox.mjs';
import {bindControlledRepairCheckpoint} from './dispatch-store.mjs';
import {verifyNativeResumeFailureLive} from './native-resume-failure.mjs';
import {CONTROLLED_CONTINUATION,CONTROLLED_CONTINUATION_COMMENT,
  CONTROLLED_V2_CONTINUATION,CONTROLLED_V2_CONTINUATION_COMMENT} from './development-resume.mjs';
import {CONTROLLED_FAILED_RUN,verifyKnownFailureLive} from './failed-worker-recover.mjs';
import {CONTROLLED_ORIGINAL_PUBLICATION} from '../publisher/publication-readback.mjs';

const REPO='BestNathan/nession';
const WORKFLOW='.github/workflows/agent-controller-dispatch.yml';
export const CONTROLLED_DISPATCH_COMMENT='/nession dispatch issue=1997 action=95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae';
export const CONTROLLED_RECOVERY_COMMENT='/nession recover issue=1997 failed_run=39267659650';
export const CONTROLLED_NATIVE_RECOVERY_COMMENT='/nession recover-native issue=1997 failed_run=39376331942';
export const CONTROLLED_REVIEW_RECOVERY_COMMENT='/nession recover-review issue=1997 skipped_run=39943178597';
export const CONTROLLED_REPAIR_BIND_COMMENT='/nession bind-repair issue=1997 action=d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
export const CONTROLLED_REPAIR_DISPATCH_COMMENT='/nession dispatch-repair issue=1997 action=d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const REVIEW_DISPATCH_PREFIX='/nession dispatch-review issue=1997 action=';
const REVIEW_DISPATCH_RE=/^\/nession dispatch-review issue=1997 action=([a-f0-9]{64})$/;
const REPAIR_ACTION='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
const ORIGINAL_ACTION='95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae';
const RECOVERY_ACTION=failedDeveloperRetryActionId(1997,ORIGINAL_ACTION,CONTROLLED_FAILED_RUN);
const NATIVE_RECOVERY_ACTION=nativeResumeSuccessorId(1997,CONTROLLED_CONTINUATION,39376331942);
const REVIEW_ACTION='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
function fail(s){throw Error('trusted Controller dispatch: '+s);}
export function assertDispatchAuthority({environment,event,run,issue,actionId}) {
  const commanded=environment.GITHUB_EVENT_NAME==='issue_comment';
  const permitted=commanded
    ?(event?.action==='created'&&event?.issue?.number===1997&&
       !event?.issue?.pull_request&&event?.comment?.user?.login==='BestNathan'&&
       ((event?.comment?.body===CONTROLLED_DISPATCH_COMMENT&&actionId===ORIGINAL_ACTION)||
        (event?.comment?.body===CONTROLLED_RECOVERY_COMMENT&&actionId===RECOVERY_ACTION)||
        (event?.comment?.body===CONTROLLED_CONTINUATION_COMMENT&&actionId===CONTROLLED_CONTINUATION)||
        (event?.comment?.body===CONTROLLED_V2_CONTINUATION_COMMENT&&actionId===CONTROLLED_V2_CONTINUATION)||
        (event?.comment?.body===CONTROLLED_NATIVE_RECOVERY_COMMENT&&actionId===NATIVE_RECOVERY_ACTION)||
        (event?.comment?.body===CONTROLLED_REVIEW_RECOVERY_COMMENT&&actionId===REVIEW_ACTION)||
        (event?.comment?.body===CONTROLLED_REPAIR_BIND_COMMENT&&actionId===REPAIR_ACTION)||
        (event?.comment?.body===CONTROLLED_REPAIR_DISPATCH_COMMENT&&actionId===REPAIR_ACTION)||
        (REVIEW_DISPATCH_RE.exec(event?.comment?.body??'')?.[1]===actionId))&&
       Number.isSafeInteger(event?.comment?.id)&&event.comment.id>0&&
       issue===1997)
    :(environment.GITHUB_EVENT_NAME==='workflow_dispatch'&&
       event?.ref==='refs/heads/main'&&
       Number(event?.inputs?.issue_number)===issue&&
       event?.inputs?.action_id===actionId&&
       Object.keys(event?.inputs??{}).sort().join(',')==='action_id,issue_number');
  if(environment.GITHUB_ACTIONS!=='true'||
      environment.GITHUB_REPOSITORY!==REPO||
      environment.GITHUB_REF!=='refs/heads/main'||
      environment.GITHUB_WORKFLOW!=='Agent / Controller Dispatch'||
      !permitted||
      environment.GITHUB_ACTOR!=='BestNathan'||
      !HEX40.test(environment.GITHUB_SHA??'')||
      !positive(Number(environment.GITHUB_RUN_ID))||
      Number(environment.GITHUB_RUN_ATTEMPT)!==1||
      !positive(issue)||!HEX64.test(actionId??'')||
      event?.repository?.full_name!==REPO||
      run?.id!==Number(environment.GITHUB_RUN_ID)||
      run?.run_attempt!==1||
      run?.event!==environment.GITHUB_EVENT_NAME||
      run?.path!==WORKFLOW||
      run?.name!=='Agent / Controller Dispatch'||
      run?.actor?.login!=='BestNathan'||
      run?.head_branch!=='main'||
      run?.head_sha!==environment.GITHUB_SHA||
      run?.repository?.full_name!==REPO||
      run?.head_repository?.full_name!==REPO) {
    fail('missing exact authenticated owner/main Controller Run');
  }
  return Object.freeze({issue,action_id:actionId,issuer_run_id:run.id});
}
export function parseDispatchKey(encoded) {
  if(typeof encoded!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    fail('missing canonical base64 HMAC key');
  const key=Buffer.from(encoded,'base64');
  if(key.length<32||key.toString('base64')!==encoded)
    fail('HMAC key must contain at least 32 bytes');
  return key;
}
export function deriveDispatchKey(privateKey) {
  if(typeof privateKey!=='string'||privateKey.length<200||
      !privateKey.includes('-----BEGIN')||!privateKey.includes('PRIVATE KEY-----'))
    fail('missing Store Writer App private key for domain-separated HMAC');
  return Buffer.from(hkdfSync('sha256',Buffer.from(privateKey),
    Buffer.from('BestNathan/nession','utf8'),
    Buffer.from('nession-agent-controller-dispatch-v1','utf8'),32));
}
async function api(token,resource) {
  const r=await fetch('https://api.github.com/repos/'+REPO+resource,{
    headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2026-03-10'}});
  if(!r.ok)fail('GitHub authority read failed ('+r.status+')');
  return r.json();
}
function sourceStillAllowed(sha, role, task) {
  return sourceAllowed(sha, role, {task});
}
// A Developer action points at a source commit that must be reachable from
// current main. A Reviewer action points at the published PR head, which is
// not a main ancestor; the trusted ingest wrote that action after verifying the
// publication, so require the target to descend from the original published
// main SHA instead. Exported for deterministic fixtures.
export function sourceAllowed(sha, role, { run = (args) => execFileSync('git', args,
  { stdio: 'ignore', timeout: 5000 }), mainSha = process.env.GITHUB_SHA,
  publishedMainSha = CONTROLLED_ORIGINAL_PUBLICATION.publisher_main_sha,
  task = null } = {}) {
  if (!HEX40.test(sha ?? '')) fail('invalid dispatch source SHA');
  if (role !== 'developer' && role !== 'reviewer') fail('invalid dispatch role');
  try {
    run(['cat-file', '-e', sha + '^{commit}']);
  } catch {
    fail('dispatch source SHA is not a commit');
  }
  const repair=role==='developer'&&task?.task==='repair';
  if(repair&&(sha!=='3d8e3807cc01f6082734b8d0ba458217c28f60a4'||
      task?.sha!==sha||task?.agent_id!=='dev-cursor-01'||
      task?.repair_checkpoint?.source_sha!=='220266b9233ec97b1beacbc54e5cc7f82d3cece2'||
      task?.repair_checkpoint?.source_run_id!==39448549052))
    fail('Repair target is not the exact authenticated published PR source');
  try {
    if(role==='reviewer'||repair)
      run(['merge-base','--is-ancestor',publishedMainSha,sha]);
    else run(['merge-base', '--is-ancestor', sha, mainSha]);
  } catch {
    if(role==='reviewer'||repair)
      fail('Reviewer/Repair target is not on the published branch history');
    fail('Developer source SHA is not a reachable trusted main ancestor');
  }
}
// One exact historical source is independently authenticated before signing
// the replacement. The old unsigned manual Review Run is never reusable.
export async function verifyKnownSkippedReviewerLive(token) {
  const run=await api(token,'/actions/runs/39943178597');
  if(run?.id!==39943178597||run.run_attempt!==1||
      run.path!=='.github/workflows/agent-review.yml'||
      run.name!=='Agent / Review'||run.event!=='workflow_dispatch'||
      run.head_branch!=='main'||run.head_sha!=='153cb8bdce062b37c94648e136fc8bea21195971'||
      run.actor?.login!=='github-actions[bot]'||
      run.status!=='completed'||run.conclusion!=='skipped'||
      run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO)
    fail('unverified historical skipped Reviewer source Run');
  const pr=await api(token,'/pulls/2176');
  if(pr?.number!==2176||pr.state!=='open'||
      pr.head?.sha!=='3d8e3807cc01f6082734b8d0ba458217c28f60a4'||
      pr.head?.ref!=='agent/1997/developer-checkpoint-v3'||
      pr.head?.repo?.full_name!==REPO||pr.base?.repo?.full_name!==REPO)
    fail('controlled published Reviewer PR changed');
  return Object.freeze({verified:true,run_id:run.id,attempt:run.run_attempt,
    conclusion:'skipped'});
}
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='dispatch')
    fail('usage: dispatch (only from trusted main workflow)');
  const env=process.env;
  let event;
  try{event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));}
  catch{fail('unavailable trusted GitHub workflow event');}
  const commanded=env.GITHUB_EVENT_NAME==='issue_comment';
  const issue=commanded?1997:Number(event?.inputs?.issue_number);
  const recovering=commanded&&event?.comment?.body===CONTROLLED_RECOVERY_COMMENT;
  const continuing=commanded&&event?.comment?.body===CONTROLLED_CONTINUATION_COMMENT;
  const continuingV2=commanded&&event?.comment?.body===CONTROLLED_V2_CONTINUATION_COMMENT;
  const recoveringNative=commanded&&event?.comment?.body===CONTROLLED_NATIVE_RECOVERY_COMMENT;
  const recoveringReview=commanded&&event?.comment?.body===CONTROLLED_REVIEW_RECOVERY_COMMENT;
  const bindingRepair=commanded&&event?.comment?.body===CONTROLLED_REPAIR_BIND_COMMENT;
  const dispatchingRepair=commanded&&event?.comment?.body===CONTROLLED_REPAIR_DISPATCH_COMMENT;
  const newReviewAction=commanded?REVIEW_DISPATCH_RE.exec(event?.comment?.body??'')?.[1]:null;
  const actionId=commanded?(newReviewAction??(bindingRepair||dispatchingRepair?REPAIR_ACTION:
    recoveringReview?REVIEW_ACTION:
    continuingV2?CONTROLLED_V2_CONTINUATION:
    continuing?CONTROLLED_CONTINUATION:recoveringNative?NATIVE_RECOVERY_ACTION:
    recovering?RECOVERY_ACTION:ORIGINAL_ACTION)):event?.inputs?.action_id;
  if(!positive(issue)||!HEX64.test(actionId??''))fail('invalid Issue/Action');
  const token=env.ACTIONS_DISPATCH_TOKEN;
  if(typeof token!=='string'||token.length<8)fail('missing trusted Actions credential');
  const run=await api(token,'/actions/runs/'+env.GITHUB_RUN_ID);
  assertDispatchAuthority({environment:env,event,run,issue,actionId});
  const issueRecord=await api(token,'/issues/'+issue);
  if(issueRecord.number!==issue||issueRecord.state!=='open'||issueRecord.pull_request||
      issueRecord.repository_url!=='https://api.github.com/repos/'+REPO)
    fail('Issue is not an authorized open native Issue');
  // The Store reader is unprivileged and runs before Store App credential use.
  // No other Issue/Agent/Role may be introduced by workflow_dispatch inputs.
  const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
  const storeRemote=env.AGENT_STORE_CONTROLLER_REMOTE;
  if(!storeRemote?.startsWith('https://x-access-token:')||
      !storeRemote.endsWith('@github.com/'+REPO+'.git'))
    fail('expected existing scoped App Store writer remote');
  // Derive a distinct HMAC domain from the existing trusted Store App key.
  // No additional secret setup; this key and the App private key never enter Worker.
  const key=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    if(bindingRepair){
      const result=bindControlledRepairCheckpoint({
        remote:storeRemote,issue:1997,actionId:REPAIR_ACTION});
      console.log(JSON.stringify(result));
      return; // No GitHub workflow_dispatch or model call from binding command.
    }
    if(recoveringReview){
      const source=await verifyKnownSkippedReviewerLive(token);
      const signer={key,key_id:'main-controller',
        issuer_run_id:run.id,now:Date.now(),ttl_ms:600000};
      const result=await executeControlledReviewerRecovery({
        remote:storeRemote,registry,signer,actionsToken:token,source});
      console.log(JSON.stringify(result));
      return;
    }
    if(recovering){
      const verified=await verifyKnownFailureLive(token);
      const recovery=recoverConfirmedFailedDeveloperDispatch({
        remote:storeRemote,issue:1997,actionId:ORIGINAL_ACTION,
        runId:verified.run_id,verified:verified.verified});
      if(recovery.action_id!==actionId||!['recovered','replayed'].includes(recovery.status))
        fail('recovery action is not the independently verified CAS successor');
    }
    if(recoveringNative){
      const verified=await verifyNativeResumeFailureLive(token);
      const recovery=recoverAttestedNativeResumeFailure({remote:storeRemote,source:verified});
      if(recovery.action_id!==actionId||!['recovered','replayed'].includes(recovery.status))
        fail('native recovery action is not the verified CAS successor');
    }
    const signer={key,key_id:'main-controller',
      issuer_run_id:run.id,now:Date.now(),ttl_ms:600000};
    // Source ancestry is rechecked against the persisted pending Outbox
    // action by a no-post preflight hook inside the trusted CAS path.
    const result=await executeDurableAgentDispatch({
      remote:storeRemote,issue,actionId,registry,signer,
      actionsToken:token,sourceVerifier:sourceStillAllowed,
    });
    // A 204/timeout may have created a Worker: never claim completed.
    console.log(JSON.stringify({status:result.status,issue,action_id:actionId,
      ...(result.source_run_id?{run_id:result.source_run_id}:{}),
      ...(result.state_version?{state_version:result.state_version}:{})}));
  }finally{key.fill(0);}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
}
