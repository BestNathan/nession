#!/usr/bin/env node
// #2010. Authenticated main-owned dispatch driver. This process owns the
// Store CAS writer and Actions dispatch token. NEVER run from a Provider,
// untrusted checkout, PR head, model tool or Developer environment.
import fs from 'node:fs';
import {hkdfSync} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {executeDurableAgentDispatch,recoverConfirmedFailedDeveloperDispatch} from './dispatch-store.mjs';
import {failedDeveloperRetryActionId} from './outbox.mjs';
import {CONTROLLED_CONTINUATION,CONTROLLED_CONTINUATION_COMMENT} from './development-resume.mjs';
import {CONTROLLED_FAILED_RUN,verifyKnownFailureLive} from './failed-worker-recover.mjs';

const REPO='BestNathan/nession';
const WORKFLOW='.github/workflows/agent-controller-dispatch.yml';
export const CONTROLLED_DISPATCH_COMMENT='/nession dispatch issue=1997 action=95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae';
export const CONTROLLED_RECOVERY_COMMENT='/nession recover issue=1997 failed_run=39267659650';
const ORIGINAL_ACTION='95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae';
const RECOVERY_ACTION=failedDeveloperRetryActionId(1997,ORIGINAL_ACTION,CONTROLLED_FAILED_RUN);
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
        (event?.comment?.body===CONTROLLED_CONTINUATION_COMMENT&&actionId===CONTROLLED_CONTINUATION))&&
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
function sourceStillAllowed(sha){
  if(!HEX40.test(sha??''))fail('invalid dispatch source SHA');
  try{
    execFileSync('git',['cat-file','-e',sha+'^{commit}'],{stdio:'ignore',timeout:5000});
    execFileSync('git',['merge-base','--is-ancestor',sha,process.env.GITHUB_SHA],
      {stdio:'ignore',timeout:5000});
  }catch{fail('Developer source SHA is not a reachable trusted main ancestor');}
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
  const actionId=commanded?(continuing?CONTROLLED_CONTINUATION:
    recovering?RECOVERY_ACTION:ORIGINAL_ACTION):event?.inputs?.action_id;
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
    if(recovering){
      const verified=await verifyKnownFailureLive(token);
      const recovery=recoverConfirmedFailedDeveloperDispatch({
        remote:storeRemote,issue:1997,actionId:ORIGINAL_ACTION,
        runId:verified.run_id,verified:verified.verified});
      if(recovery.action_id!==actionId||!['recovered','replayed'].includes(recovery.status))
        fail('recovery action is not the independently verified CAS successor');
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
