// #1664: Trusted Controller-only Git transaction boundary around workflow_dispatch.
// Repository scope, HMAC signing key, and Git writer token MUST be supplied
// by the independently authenticated Controller/Ingester, never by Provider
// scripts or a PR-head checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState,writeIssueWorkflowState,issueStatePath} from './state-store.mjs';
import {reconcileOutbox,recordDispatch} from './outbox.mjs';
import {prepareGitHubDispatch,verifyPersistedDispatchIntent,createGitHubDispatchClient}
  from './github-dispatch.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {publish} from '../../../run-store-cas-push.mjs';

const REF='agent-store';
function fail(message){throw Error('trusted dispatch Store: '+message);}
function git(dir,args){
  try{return execFileSync('git',['-C',dir,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
    maxBuffer:2*1024*1024,env:{...process.env,
      GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}catch(e){fail('Git operation '+args[0]+' failed ('+(e.status??'unknown')+')');}
}
function withStore(remote,perform) {
  if(typeof remote!=='string'||!remote||remote.length>2000||/\s/.test(remote))
    fail('invalid scoped remote');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-dispatch-store-'));
  const checkout=path.join(dir,'agent-store');
  try{
    try{execFileSync('git',['clone','--no-tags','--single-branch',
      '--branch',REF,'--',remote,checkout],{
      encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,
      maxBuffer:2*1024*1024,env:{...process.env,
        GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });}catch(e){fail('preinitialized Store checkout failed ('+(e.status??'unknown')+')');}
    if(git(checkout,['symbolic-ref','--short','HEAD'])!==REF)
      fail('untrusted Store branch');
    return perform(checkout);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function persist(dir,state,previousVersion,issue) {
  writeIssueWorkflowState(dir,state,previousVersion);
  git(dir,['add','-A']);
  const audit=auditStagedRunStore(dir,REF);
  if(audit.checked_changes!==2)fail('expected one immutable state and one CAS head');
  git(dir,['-c','user.name=nession-agent-controller',
    '-c','user.email=nession-agent-controller@users.noreply.github.com',
    'commit','-m','agent-store: Issue '+issue+' dispatch state v'+state.version]);
  return publish(REF,dir,4);
}
// Begin the exact external side effect ONLY after this function returns
// status='committed'. If it returns 'reconcile', never repeat HTTP POST.
// The persistent intent is an immutable no-redelivery fence after a crash.
export function commitDispatchIntent({remote,issue,actionId,registry,signer}) {
  if(!Number.isSafeInteger(issue)||issue<1||
      !/^[a-f0-9]{64}$/.test(actionId??''))fail('invalid Issue/Action identity');
  return withStore(remote,dir=>{
    const previous=readIssueWorkflowState(dir,issue);
    if(!previous.state)fail('Controller Issue has not been initialized');
    const state=previous.state;
    const candidate=state.outbox.find(x=>x.id===actionId);
    if(!candidate)fail('action absent from authenticated Issue');
    if(candidate.status!=='pending'){
      // Crucially do not return a usable signed POST plan to a restarted Run.
      return {status:'reconcile',issue,action_id:actionId,
        action_status:candidate.status,state_version:previous.version,
        store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    const {plan,prepared}=prepareGitHubDispatch(state,actionId,registry,signer);
    const published=persist(dir,prepared,previous.version,issue);
    if(published.replayed)fail('newly prepared intent unexpectedly replayed');
    return {status:'committed',issue,action_id:actionId,
      state_version:prepared.version,store_commit_sha:published.commit_sha,
      plan};
  });
}
// Only a trusted GitHub API reader/dispatcher with a verified HTTP 200
// response may acknowledge the intent. A 204/timeout is ambiguous, not a
// failure that licenses redelivery.
export function acknowledgeCommittedDispatch({
  remote,issue,actionId,ticketSha256,receipt,
}) {
  if(!Number.isSafeInteger(issue)||issue<1||
      !/^[a-f0-9]{64}$/.test(actionId??'')||
      !/^[a-f0-9]{64}$/.test(ticketSha256??'')||
      receipt?.status!=='verified'||receipt?.dispatch_id!==actionId||
      !Number.isSafeInteger(receipt?.source_run_id)||receipt.source_run_id<1)
    fail('missing authenticated HTTP 200 Run receipt or dispatch identity');
  return withStore(remote,dir=>{
    const read=readIssueWorkflowState(dir,issue);
    if(!read.state)fail('Controller Issue unavailable');
    const action=read.state.outbox.find(x=>x.id===actionId);
    if(!action)fail('unknown prepared action');
    if(action.status==='dispatched'){
      // Check the original committed intent as well: the dispatched receipt
      // deliberately contains only public Run identity, not a second copy of
      // the HMAC Ticket. A conflicting request must never be reported as a
      // successful idempotent replay.
      if(read.version<2)fail('missing historical write-ahead state');
      const previous=path.join(dir,issueStatePath(issue,read.version-1));
      let prepared;
      try{prepared=JSON.parse(fs.readFileSync(previous,'utf8'));}
      catch{fail('missing immutable write-ahead history');}
      const previousAction=prepared.outbox?.find(x=>x.id===actionId);
      if(previousAction?.status!=='dispatching'||
          previousAction.receipt?.ticket_sha256!==ticketSha256)
        fail('unmatched immutable write-ahead receipt history');
      if(action.receipt?.status!=='verified'||
          action.receipt.source_run_id!==receipt.source_run_id)
        fail('conflicting acknowledged source Run');
      return {status:'replayed',issue,action_id:actionId,
        source_run_id:receipt.source_run_id,state_version:read.version,
        store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    if(action.status!=='dispatching'||action.receipt?.ticket_sha256!==ticketSha256)
      fail('missing or mismatched persisted write-ahead intent');
    const advanced=recordDispatch(read.state,read.version,actionId,receipt);
    const published=persist(dir,advanced,read.version,issue);
    if(published.replayed)fail('unexpected replay during first Run acknowledgement');
    return {status:'acknowledged',issue,action_id:actionId,
      source_run_id:receipt.source_run_id,state_version:advanced.version,
      store_commit_sha:published.commit_sha};
  });
}

// Single trusted Driver entrypoint for an authorized pending action.
// Step 1: use the existing Store CAS to commit a new immutable write-ahead
//         intent BEFORE any external workflow_dispatch.
// Step 2: clone the remote ref again and attest that exact signed Ticket
//         belongs to the newly committed persisted state.
// Step 3: issue exactly ONE GitHub POST. A crash, network error or HTTP 204
//         preserves the dispatching state; subsequent calls return reconcile
//         WITHOUT a POST. Never "compensate" by blindly redispatching.
// Step 4: only GitHub's HTTP 200 downstream Run ID can be acknowledged by
//         another CAS commit. Worker result ingestion remains a separate step.
//
// Provider agents never call this. Its Store credential is scoped to the
// trusted Ingest; actionsToken is independent of Store/App and only supports
// the Actions workflow dispatch endpoint. No secret enters the Worker plan.
export async function executeDurableAgentDispatch({
  remote,issue,actionId,registry,signer,actionsToken,now=Date.now(),
  fetchFn=null,
}) {
  if(typeof actionsToken!=='string'||actionsToken.length<8)
    fail('trusted Actions dispatch token required');
  if(!signer||!Buffer.isBuffer(signer.key)||signer.key.length<32||
      typeof signer.key_id!=='string')
    fail('trusted Controller HMAC signer required');
  if(fetchFn!==null&&(process.env.NODE_ENV!=='test'||typeof fetchFn!=='function'))
    fail('mock Actions client unavailable outside fixture tests');
  const issued=commitDispatchIntent({remote,issue,actionId,registry,signer});
  if(issued.status!=='committed')return issued;
  const keyring={[signer.key_id]:signer.key};
  const verified=withStore(remote,dir=>{
    const current=readIssueWorkflowState(dir,issue);
    if(!current.state)fail('prepared Issue vanished from remote Store');
    return verifyPersistedDispatchIntent({
      state:current.state,plan:issued.plan,keyring,now,
    });
  });
  if(verified.action_id!==actionId||
      verified.state_version!==issued.state_version)
    fail('committed intent version mismatch');
  const dispatch=createGitHubDispatchClient(actionsToken,{
    keyring,now,...(fetchFn?{fetchFn}:{})
  });
  // DO NOT add a retry loop here, even for HTTP 429 or network failure.
  const response=await dispatch(issued.plan);
  if(response.status!=='verified'){
    return {status:'ambiguous',issue,action_id:actionId,
      state_version:issued.state_version,
      store_commit_sha:issued.store_commit_sha,
      reason:'GitHub accepted dispatch without authenticated downstream Run ID'};
  }
  const acknowledged=acknowledgeCommittedDispatch({
    remote,issue,actionId,ticketSha256:verified.ticket_sha256,
    receipt:response,
  });
  return {status:'dispatched',issue,action_id:actionId,
    source_run_id:response.source_run_id,
    store_commit_sha:acknowledged.store_commit_sha,
    state_version:acknowledged.state_version};
}
