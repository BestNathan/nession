import {createHash} from 'node:crypto';
// #1664: Trusted Controller-only Git transaction boundary around workflow_dispatch.
// Repository scope, HMAC signing key, and Git writer token MUST be supplied
// by the independently authenticated Controller/Ingester, never by Provider
// scripts or a PR-head checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readIssueWorkflowState,writeIssueWorkflowState,issueStatePath} from './state-store.mjs';
import {reconcileOutbox,recordDispatch,recordAttestedDeveloperFailure,failedDeveloperRetryActionId,
  recordAttestedNativeResumeFailure,nativeResumeSuccessorId,
  recordControlledReviewerRecoveryIntent,bindVerifiedRepairCheckpoint,
  acceptTaskResult} from './outbox.mjs';
import {prepareGitHubDispatch,verifyPersistedDispatchIntent,createGitHubDispatchClient,
  verifyDispatchTicket,planControlledReviewerRecovery,acceptAttestedSliceYield}
  from './github-dispatch.mjs';
import {readPublishedRepairCheckpoint} from './repair-checkpoint.mjs';
import {auditStagedRunStore} from '../../../run-store-integrity.mjs';
import {verifyCommittedCheckpoint} from '../store/remote.mjs';
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
// The one #1997 Repair origin can be attached only by the already-trusted
// Store writer, after independent immutable pre-publish Run/Checkpoint
// inspection in the same checkout. This operation has NO workflow_dispatch,
// Provider, PR or Issue side effect. A subsequent versioned ticket/Worker
// implementation must still be separately activated before any Repair POST.
export function bindControlledRepairCheckpoint({remote,issue,actionId}){
  if(issue!==1997||
     actionId!=='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d')
    fail('only exact #1997 reviewed Repair is authorized');
  return withStore(remote,dir=>{
    const prior=readIssueWorkflowState(dir,issue);
    if(!prior.state)fail('missing initialized Repair Issue');
    const origin=readPublishedRepairCheckpoint(dir,prior.state,actionId);
    const next=bindVerifiedRepairCheckpoint(prior.state,prior.version,actionId,origin);
    if(next===prior.state)return {status:'replayed',issue,action_id:actionId,
      state_version:prior.version,store_commit_sha:git(dir,['rev-parse','HEAD'])};
    const pushed=persist(dir,next,prior.version,issue);
    if(pushed.replayed)fail('unexpected first Repair origin CAS replay');
    return {status:'bound',issue,action_id:actionId,
      state_version:next.version,store_commit_sha:pushed.commit_sha};
  });
}

// A completed native same-Session Repair with no PR modification is an
// authenticated Developer response to Reviewer changes_requested, not a new
// PR publication and not a request to waive the Reviewer outcome. Only the
// already authenticated, checksum-matched Worker + independently committed
// v4 ciphertext may advance the original pending Repair to a NEW Review.
// All protocol transitions stay with acceptTaskResult and a single Store CAS.
export function commitAttestedRepairDispute({remote,run,checkpoint,registry,pr}){
  const issue=1997;
  const actionId='d899dfc9367cdc9d98a6dcbcd7e55ce2d962f1d72e54abf0d61b0dd7e308009d';
  const prSha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
  if(!Number.isSafeInteger(run?.id)||run.id<1||run?.run_attempt!==1||
     run.path!=='.github/workflows/agent-develop.yml'||
     run.name!=='Agent / Development'||run.event!=='workflow_dispatch'||
     run.actor?.login!=='github-actions[bot]'||
     run.head_branch!=='main'||run.repository?.full_name!=='BestNathan/nession'||
     run.head_repository?.full_name!=='BestNathan/nession'||
     !/^[a-f0-9]{40}$/.test(run.head_sha??'')||
     run.status!=='completed'||run.conclusion!=='success'||
     pr?.number!==2176||pr.state!=='open'||pr.head?.sha!==prSha||
     pr.head?.ref!=='agent/1997/developer-checkpoint-v3'||
     pr.head?.repo?.full_name!=='BestNathan/nession'||
     pr.base?.repo?.full_name!=='BestNathan/nession'||
     checkpoint?.version!==4||!(/^[a-f0-9]{40}$/).test(checkpoint.commit_sha??'')||
     !(/^[a-f0-9]{64}$/).test(checkpoint.ciphertext_sha256??''))
    fail('Repair commit requires exact authentic source Run, PR and v4 checkpoint');
  return withStore(remote,dir=>{
    const prior=readIssueWorkflowState(dir,issue);
    if(!prior.state)fail('Repair workflow State missing');
    const existing=prior.state.transitions.filter(t=>t.kind==='developer'&&
      t.run_id===run.id&&t.attempt===run.run_attempt);
    if(existing.length){
      if(existing.length!==1||existing[0].target_sha!==prSha||
         existing[0].outcome!=='implementation_ready')
        fail('conflicting authenticated Repair replay');
      return {status:'replayed',issue,action_id:actionId,
        state_version:prior.version,store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    const action=prior.state.outbox.find(x=>x.id===actionId);
    if(prior.state.phase!=='repair'||action?.status!=='dispatched'||
       action.task.role!=='developer'||action.task.task!=='repair'||
       action.task.agent_id!=='dev-cursor-01'||action.task.sha!==prSha||
       action.task.repair_checkpoint?.checkpoint_version!==3||
       action.receipt?.status!=='verified'||action.receipt.source_run_id!==run.id)
      fail('Repair is not the exact authenticated pending Worker Run');
    verifyCommittedCheckpoint({
      remote,identity:{role:'developer',agent_id:'dev-cursor-01',issue},
      commit_sha:checkpoint.commit_sha,version:4,
      ciphertext_sha256:checkpoint.ciphertext_sha256,
    });
    // The public object is metadata only; never expose its ciphertext in
    // a log. Git-backed commitment above verifies creation SHA and head.
    const checkpointFile=path.join(dir,
      'roles/developer/dev-cursor-01/issues/1997/checkpoints/00000004.json');
    const checkpointRecord=JSON.parse(fs.readFileSync(checkpointFile,'utf8'));
    if(checkpointRecord?.metadata?.provider!=='cursor'||
       checkpointRecord?.metadata?.source_sha!==prSha||
       checkpointRecord?.metadata?.session_id!=='agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6')
      fail('committed Repair ciphertext is not same native Agent and PR source');
    const result={kind:'developer',issue,run_id:run.id,run_attempt:1,
      target_sha:prSha,outcome:'implementation_ready',task_id:actionId};
    const source={repository:'BestNathan/nession',path:run.path,name:run.name,
      run_id:run.id,attempt:1,event:run.event,ref:'refs/heads/main',
      issue,task_id:actionId,agent_id:'dev-cursor-01',input_sha:prSha,
      output_sha:prSha,verified:true};
    const next=acceptTaskResult(prior.state,prior.version,result,source,registry);
    if(next.phase!=='review'||next.outbox.filter(x=>
       x.status==='pending'&&x.task.role==='reviewer').length!==1||
       next.outbox.some(x=>x.id===actionId))
      fail('Repair must lead to exactly one new Reviewer action');
    const pushed=persist(dir,next,prior.version,issue);
    if(pushed.replayed)fail('unexpected Repair result Store replay');
    return {status:'accepted',issue,action_id:actionId,
      state_version:next.version,store_commit_sha:pushed.commit_sha,
      reviewer_action_id:next.outbox.find(x=>
        x.status==='pending'&&x.task.role==='reviewer').id};
  });
}

// Begin the exact external side effect ONLY after this function returns
// status='committed'. If it returns 'reconcile', never repeat HTTP POST.
// The persistent intent is an immutable no-redelivery fence after a crash.
export function commitDispatchIntent({remote,issue,actionId,registry,signer,sourceVerifier=null}) {
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
    if(sourceVerifier!==null){
      if(typeof sourceVerifier!=='function')fail('invalid main SHA source verifier');
      sourceVerifier(candidate.task.sha,candidate.task.role);
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
// A separate trusted result ingester uses this AFTER checkpoint Store CAS.
// It never grants the Worker any writer token or accepts model-authored source
// identity. authenticate/verify the actual GitHub Run and encrypted commit
// with acceptAttestedSliceYield before publishing the next Outbox action.
// Exact, one-off security recovery for the FIRST real #1997 Worker Run.
// No retry of original POST. Only authenticated completed failed Worker Run,
// known SDK-isolation incompatibility, absent model artifact/checkpoint and a
// matching immutable Store Run ID can create a NEW bounded dispatch action.
// Caller performs independent GitHub REST Run + job-step + artifact attestation
// before passing the verified source flag.
export function recoverConfirmedFailedDeveloperDispatch({
  remote,issue,actionId,runId,verified,
}) {
  if(issue!==1997||
      actionId!=='95b467a90a33b503dc19fb59f3a50378860e6e1eaa2961a0929ca97ae020edae'||
      runId!==39267659650||verified!==true)
    fail('only independently attested #1997 native SDK failure is recoverable');
  return withStore(remote,dir=>{
    const old=readIssueWorkflowState(dir,issue);
    if(!old.state)fail('missing trusted Issue head');
    const action=old.state.outbox.find(x=>x.id===actionId);
    if(action?.status==='failed'){
      const nextId=failedDeveloperRetryActionId(issue,actionId,runId);
      const next=old.state.outbox.find(x=>x.id===nextId);
      if(!next||!['pending','dispatching','dispatched','yielded'].includes(next.status))
        fail('conflicting recovery replay');
      return {status:'replayed',issue,action_id:nextId,state_version:old.version,
        store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    if(old.version!==3||action?.status!=='dispatched'||
        action.receipt?.status!=='verified'||
        action.receipt.source_run_id!==runId||
        action.task.role!=='developer'||action.task.task!=='implement'||
        action.task.agent_id!=='dev-cursor-01'||
        action.task.sha!=='220266b9233ec97b1beacbc54e5cc7f82d3cece2')
      fail('original authenticated Store dispatch has diverged');
    const dirPrefix='roles/developer/dev-cursor-01/issues/1997';
    const runObject=path.join(dir,dirPrefix+'/runs/'+runId+'-1.json');
    if(fs.existsSync(runObject)||fs.existsSync(path.join(dir,dirPrefix+'/head.json')))
      fail('cannot recover Worker that has a committed checkpoint');
    const next=recordAttestedDeveloperFailure(old.state,old.version,actionId,{
      verified:true,issue,run_id:runId,attempt:1,
      failure_code:'native_sdk_sandbox_unavailable',
    });
    const published=persist(dir,next,old.version,issue);
    return {status:'recovered',issue,
      action_id:failedDeveloperRetryActionId(issue,actionId,runId),
      state_version:next.version,store_commit_sha:published.commit_sha};
  });
}

// Exactly once recovery of the real owner-guard-skipped #1997 Reviewer Run.
// A durable CAS intent precedes the new external workflow_dispatch; crashes,
// 204s, timeouts and retries NEVER authorize another POST. The original Run
// receipt remains in Store until Reviewer result ingest verifies replacement.
export async function executeControlledReviewerRecovery({
  remote,registry,signer,actionsToken,source,fetchFn=null,
}) {
  const issue=1997;
  const actionId='555b3351ddb8c7ddbc23ba789f8a8a9560a01cc3112834f15492382e13af4434';
  if(source?.verified!==true||source.run_id!==39943178597||
     source.attempt!==1||source.conclusion!=='skipped'||
     typeof actionsToken!=='string'||actionsToken.length<8||
     !Buffer.isBuffer(signer?.key)||signer.key.length<32||
     signer.key_id!=='main-controller'||!Number.isSafeInteger(signer.issuer_run_id)||
     signer.issuer_run_id<1)
    fail('historical Reviewer recovery requires authenticated old Run and owner signer');
  if(fetchFn!==null&&(process.env.NODE_ENV!=='test'||typeof fetchFn!=='function'))
    fail('mock Actions client unavailable outside fixtures');
  const now=signer.now;
  const issued=withStore(remote,dir=>{
    const prior=readIssueWorkflowState(dir,issue);
    if(!prior.state)fail('controlled Reviewer Store state missing');
    const item=prior.state.outbox.find(x=>x.id===actionId);
    if(item?.receipt?.reviewer_recovery)
      return {status:'reconcile',issue,action_id:actionId,
        state_version:prior.version,store_commit_sha:git(dir,['rev-parse','HEAD'])};
    const plan=planControlledReviewerRecovery(prior.state,actionId,registry,signer);
    const digest=createHash('sha256').update(plan.ticket).digest('hex');
    const next=recordControlledReviewerRecoveryIntent(prior.state,prior.version,
      actionId,{kind:'controlled_review_recovery_intent',
        skipped_run_id:source.run_id,issuer_run_id:signer.issuer_run_id,
        ticket_sha256:digest,source_verified:true});
    const published=persist(dir,next,prior.version,issue);
    if(published.replayed)fail('first Reviewer recovery intent was replayed');
    return {status:'committed',issue,action_id:actionId,plan,
      state_version:next.version,store_commit_sha:published.commit_sha};
  });
  if(issued.status!=='committed')return issued;
  const keyring={[signer.key_id]:signer.key};
  withStore(remote,dir=>{
    const current=readIssueWorkflowState(dir,issue);
    const action=current.state?.outbox.find(x=>x.id===actionId);
    const ticket=verifyDispatchTicket(issued.plan.ticket,keyring,{now});
    const digest=createHash('sha256').update(issued.plan.ticket).digest('hex');
    if(current.version!==issued.state_version||
       action?.receipt?.reviewer_recovery?.ticket_sha256!==digest||
       action.receipt.reviewer_recovery.issuer_run_id!==ticket.issuer_run_id||
       ticket.action_id!==actionId||ticket.state_version!==19||
       ticket.role!=='reviewer'||ticket.issue!==issue||
       ticket.input_sha!==action.task.sha)
      fail('Reviewer recovery CAS commitment changed before dispatch');
  });
  // Never retry even if the HTTP result is ambiguous. Metrics and Reviewer
  // result ingestion reconcile independently from the signed replacement Run.
  const dispatch=createGitHubDispatchClient(actionsToken,{
    keyring,now,...(fetchFn?{fetchFn}:{})});
  const response=await dispatch(issued.plan);
  return {status:response.status==='verified'?'dispatched':'ambiguous',
    issue,action_id:actionId,state_version:issued.state_version,
    store_commit_sha:issued.store_commit_sha,
    ...(response.status==='verified'?{source_run_id:response.source_run_id}:{})};
}

// One exact historical native Resume recovery. Independent GitHub proof
// precedes this privileged Store-only CAS; absence of Checkpoint v2 is
// independently rechecked within the same checkout before mutation.
export function recoverAttestedNativeResumeFailure({remote,source}){
  if(source?.verified!==true||source.issue!==1997||
    source.run_id!==39376331942||source.attempt!==1||
    source.failure_code!=='native_cursor_agent_not_found_before_send')
    fail('unauthenticated native Cursor Resume failure');
  const original='3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8';
  return withStore(remote,dir=>{
    const read=readIssueWorkflowState(dir,1997);
    if(!read.state)fail('native Resume Issue missing');
    const action=read.state.outbox.find(x=>x.id===original);
    const successorId=nativeResumeSuccessorId(1997,original,source.run_id);
    if(action?.status==='failed'){
      const next=read.state.outbox.find(x=>x.id===successorId);
      if(action.receipt?.source_run_id!==source.run_id||
         action.receipt?.failure_code!==source.failure_code||
         !next||!['pending','dispatching','dispatched','yielded'].includes(next.status))
        fail('conflicting recovery replay');
      return {status:'replayed',issue:1997,action_id:successorId,
        state_version:read.version,store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    if(read.version!==9||action?.status!=='dispatched')
      fail('native Resume Store changed since verified failure');
    const prefix='roles/developer/dev-cursor-01/issues/1997';
    const headFile=path.join(dir,prefix,'head.json');
    let head;
    try{head=JSON.parse(fs.readFileSync(headFile,'utf8'));}catch{fail('native checkpoint Store HEAD absent');}
    if(head.version!==1||
      head.checkpoint_path!==prefix+'/checkpoints/00000001.json'||
      head.ciphertext_sha256!=='a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107'||
      fs.existsSync(path.join(dir,prefix,'runs/39376331942-1.json'))||
      fs.existsSync(path.join(dir,prefix,'checkpoints/00000002.json')))
      fail('checkpoint v2 exists or authenticated v1 changed');
    const next=recordAttestedNativeResumeFailure(read.state,read.version,original,source);
    const pushed=persist(dir,next,read.version,1997);
    if(pushed.replayed)fail('new recovery CAS unexpectedly replayed');
    return {status:'recovered',issue:1997,action_id:successorId,
      state_version:next.version,store_commit_sha:pushed.commit_sha};
  });
}

export async function commitAttestedSliceYield({
  remote,issue,dispatchTicket,keyring,reader,
  checkpoint,verifiedMainSha,now=Date.now(),
}) {
  if(!Number.isSafeInteger(issue)||issue<1||
      !Number.isSafeInteger(checkpoint?.run_id)||checkpoint.run_id<1||
      !Number.isSafeInteger(checkpoint?.attempt)||checkpoint.attempt<1)
    fail('invalid attested Slice source');
  // Read without retaining a disposable checkout across an await. The writer
  // must recheck the EXACT version under a fresh Git CAS after attestation.
  const prior=withStore(remote,dir=>readIssueWorkflowState(dir,issue));
  if(!prior.state)fail('authenticated Worker Issue is absent');
  const advanced=await acceptAttestedSliceYield({
    state:prior.state,dispatch_ticket:dispatchTicket,keyring,reader,
    remote,checkpoint,verified_main_sha:verifiedMainSha,now,
  });
  return withStore(remote,dir=>{
    const latest=readIssueWorkflowState(dir,issue);
    if(latest.version!==prior.version)
      fail('stale checkpoint acceptance; reread trusted Store evidence');
    if(advanced===prior.state) {
      return {status:'replayed',issue,state_version:prior.version,
        store_commit_sha:git(dir,['rev-parse','HEAD'])};
    }
    const published=persist(dir,advanced,prior.version,issue);
    return {status:'yielded',issue,state_version:advanced.version,
      store_commit_sha:published.commit_sha};
  });
}

export async function executeDurableAgentDispatch({
  remote,issue,actionId,registry,signer,actionsToken,now=Date.now(),
  fetchFn=null,sourceVerifier=null,
}) {
  if(typeof actionsToken!=='string'||actionsToken.length<8)
    fail('trusted Actions dispatch token required');
  if(!signer||!Buffer.isBuffer(signer.key)||signer.key.length<32||
      typeof signer.key_id!=='string')
    fail('trusted Controller HMAC signer required');
  if(fetchFn!==null&&(process.env.NODE_ENV!=='test'||typeof fetchFn!=='function'))
    fail('mock Actions client unavailable outside fixture tests');
  const issued=commitDispatchIntent({remote,issue,actionId,registry,signer,sourceVerifier});
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
