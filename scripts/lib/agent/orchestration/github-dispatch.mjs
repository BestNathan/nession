import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { resolveIdentity } from '../harness/contract.mjs';
import { validateDevelopmentState,recordSliceYield,recordDispatchIntent } from './outbox.mjs';
import { verifyCommittedCheckpoint } from '../store/remote.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const REPOSITORY = 'BestNathan/nession';
const MAX_TTL_MS = 15 * 60 * 1000;
const PROVIDERS = {
  developer: { workflow: 'agent-develop.yml', path: '.github/workflows/agent-develop.yml',
    name: 'Agent / Development', tasks: ['implement','repair'] },
  reviewer: { workflow: 'agent-review.yml', path: '.github/workflows/agent-review.yml',
    name: 'Agent / Review', tasks: ['review'] },
};
const BODY_FIELDS = ['schema_version','repository','issue','action_id','state_version',
  'role','agent_id','task','input_sha','issuer_run_id','issued_at','expires_at','key_id'];
const CONTINUATION_FIELDS = ['parent_action_id','ordinal','checkpoint_version',
  'checkpoint_commit_sha','ciphertext_sha256'];
const STORE_REF='refs/heads/agent-store';
const RESULT_FIELDS = ['kind','issue','run_id','run_attempt','target_sha','outcome','task_id'];
const SOURCE_FIELDS = ['repository','path','name','run_id','attempt','event','ref',
  'issue','task_id','agent_id','input_sha','output_sha','verified'];

function reject(text) { throw new Error('agent dispatch attestation: ' + text); }
function own(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(x => fields.includes(x));
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function keyBytes(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) reject('signing key must be at least 32 bytes');
  return key;
}
function canonical(value) {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k,value[k]])));
}
function mac(key, value) {
  return createHmac('sha256',keyBytes(key)).update(value).digest();
}
function validContinuation(value) {
  if (!own(value,CONTINUATION_FIELDS)||
      Object.keys(value).length!==CONTINUATION_FIELDS.length||
      !HEX64.test(value.parent_action_id??'')||
      !positive(value.ordinal)||value.ordinal>64||
      !positive(value.checkpoint_version)||
      !HEX40.test(value.checkpoint_commit_sha??'')||
      !HEX64.test(value.ciphertext_sha256??'')) {
    reject('invalid signed native Session continuation');
  }
  return value;
}
function validBody(body) {
  const resumed=body?.schema_version===2;
  const allowed=resumed?[...BODY_FIELDS,'resume_from']:BODY_FIELDS;
  if (!own(body,allowed) || Object.keys(body).length !== allowed.length ||
      ![1,2].includes(body.schema_version) || body.repository !== REPOSITORY || !positive(body.issue) ||
      !HEX64.test(body.action_id ?? '') || !positive(body.state_version) ||
      !PROVIDERS[body.role]?.tasks.includes(body.task) || !ID.test(body.agent_id ?? '') ||
      !HEX40.test(body.input_sha ?? '') || !positive(body.issuer_run_id) ||
      !ID.test(body.key_id ?? '') || !Number.isSafeInteger(body.issued_at) ||
      !Number.isSafeInteger(body.expires_at) ||
      body.expires_at <= body.issued_at ||
      body.expires_at - body.issued_at > MAX_TTL_MS) reject('invalid dispatch ticket body');
  if(resumed)validContinuation(body.resume_from);
  return body;
}
function decodeTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 1800 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket ?? '')) reject('malformed dispatch ticket');
  const [encoded,signature] = ticket.split('.');
  const source = Buffer.from(encoded,'base64url');
  if (source.length > 1024 || source.toString('base64url') !== encoded) reject('noncanonical dispatch encoding');
  let body;
  try { body=JSON.parse(source.toString('utf8')); } catch { reject('invalid dispatch ticket JSON'); }
  validBody(body);
  if (canonical(body) !== source.toString('utf8')) reject('noncanonical dispatch ticket body');
  const sig=Buffer.from(signature,'base64url');
  if (sig.length!==32 || sig.toString('base64url') !== signature) reject('invalid dispatch signature');
  return { body, signature:sig, encoded };
}
function sourceAction(state,actionId) {
  validateDevelopmentState(state);
  const matches=state.outbox.filter(x=>x.id===actionId && x.status==='pending');
  if (matches.length!==1) reject('action is not pending in persisted Outbox');
  const action=matches[0], t=action.task;
  if (t.type!=='dispatch' || !PROVIDERS[t.role]?.tasks.includes(t.task) ||
      state.assignments[t.role]!==t.agent_id || !HEX40.test(t.sha ?? '')) {
    reject('action is not an authorized Agent dispatch');
  }
  return action;
}
export function issueDispatchTicket(state,actionId,registry,{key,key_id,issuer_run_id,now=Date.now(),ttl_ms=600000}) {
  const action=sourceAction(state,actionId), t=action.task;
  const registered=registry.instances[t.agent_id];
  if (!registered || registered.role!==t.role) reject('unregistered Agent assignment');
  resolveIdentity(registry,t.agent_id,t.task,registered.environment);
  if (!ID.test(key_id ?? '') || !positive(issuer_run_id) || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(ttl_ms) || ttl_ms<1000 || ttl_ms>MAX_TTL_MS) {
    reject('invalid ticket signer identity or TTL');
  }
  const continuation=t.continuation==null?null:validContinuation(t.continuation);
  const body=validBody({schema_version:continuation?2:1,repository:REPOSITORY,issue:state.issue,
    action_id:action.id,state_version:state.version,role:t.role,agent_id:t.agent_id,
    task:t.task,input_sha:t.sha,issuer_run_id,issued_at:now,expires_at:now+ttl_ms,key_id,
    ...(continuation?{resume_from:continuation}:{})});
  const encoded=Buffer.from(canonical(body)).toString('base64url');
  return {ticket:encoded+'.'+mac(key,encoded).toString('base64url'),body};
}
export function verifyDispatchTicket(ticket, keyring, {now=Date.now(),allowExpired=false}={}) {
  const parsed=decodeTicket(ticket);
  if (!own(keyring,Object.keys(keyring??{}))) reject('invalid keyring');
  const key=keyring?.[parsed.body.key_id];
  if (!key) reject('unknown signing key version');
  const expected=mac(key,parsed.encoded);
  if (!timingSafeEqual(expected,parsed.signature)) reject('invalid dispatch HMAC');
  if (now<parsed.body.issued_at-30000 || (!allowExpired && now>parsed.body.expires_at)) {
    reject('dispatch ticket outside validity window');
  }
  return parsed.body;
}
export function planGitHubDispatch(state,actionId,registry,signer) {
  const {ticket,body}=issueDispatchTicket(state,actionId,registry,signer);
  const spec=PROVIDERS[body.role];
  // This is a plan, not a side effect. A trusted Coordinator must persist its
  // state/Outbox before calling workflow_dispatch. GITHUB_TOKEN dispatches
  // return HTTP 204 with NO downstream run ID.
  return {
    repository:REPOSITORY,workflow_id:spec.workflow,ref:'main',
    return_run_details:true,
    inputs:{action_id:body.action_id,issue_number:String(body.issue),agent_id:body.agent_id,
      task:body.task,input_sha:body.input_sha,dispatch_ticket:ticket,
      ...(body.schema_version===2?{resume_from:Buffer.from(canonical(body.resume_from))
        .toString('base64url')}:{})},
  };
}

// Create a signed dispatch plan while the Outbox item is pending, then save a
// write-ahead intent in the canonical state (via Store CAS) BEFORE POST.
// The ticket's issuer and hash are committed; resuming a prepared state must
// reconcile GitHub evidence and MUST NOT call workflow_dispatch a second time.
export function prepareGitHubDispatch(state,actionId,registry,signer) {
  const plan=planGitHubDispatch(state,actionId,registry,signer);
  const verified=verifyDispatchTicket(plan.inputs.dispatch_ticket,{
    [signer.key_id]:signer.key,
  },{now:signer.now??Date.now()});
  const intent={status:'prepared',dispatch_id:actionId,
    issuer_run_id:verified.issuer_run_id,
    ticket_sha256:createHash('sha256').update(plan.inputs.dispatch_ticket).digest('hex')};
  const prepared=recordDispatchIntent(state,state.version,actionId,intent);
  return {plan,prepared,intent};
}
export function verifyPersistedDispatchIntent({state,plan,keyring,now=Date.now()}) {
  validateDevelopmentState(state);
  if(!plan||plan.repository!==REPOSITORY||plan.ref!=='main'||
      !plan.return_run_details||!plan.inputs)
    reject('invalid prepared dispatch plan');
  const body=verifyDispatchTicket(plan.inputs.dispatch_ticket,keyring,{now});
  const action=state.outbox.find(x=>x.id===body.action_id);
  if(!action||action.status!=='dispatching'||action.task.type!=='dispatch'||
      action.receipt?.status!=='prepared'||
      action.receipt.dispatch_id!==body.action_id||
      action.receipt.issuer_run_id!==body.issuer_run_id||
      action.receipt.ticket_sha256!==
        createHash('sha256').update(plan.inputs.dispatch_ticket).digest('hex')||
      action.task.role!==body.role||action.task.agent_id!==body.agent_id||
      action.task.task!==body.task||action.task.sha!==body.input_sha||
      state.assignments[body.role]!==body.agent_id||
      body.state_version>=state.version||
      (action.task.continuation?
        body.schema_version!==2||
          canonical(action.task.continuation)!==canonical(body.resume_from):
        body.schema_version!==1)) {
    reject('dispatch intent not persisted at a newer Store state');
  }
  if(plan.workflow_id!==PROVIDERS[body.role].workflow||
      plan.inputs.action_id!==body.action_id||
      plan.inputs.issue_number!==String(body.issue)||
      plan.inputs.agent_id!==body.agent_id||
      plan.inputs.task!==body.task||
      plan.inputs.input_sha!==body.input_sha||
      (body.schema_version===2?
        plan.inputs.resume_from!==Buffer.from(canonical(body.resume_from)).toString('base64url'):
        Object.hasOwn(plan.inputs,'resume_from'))) {
    reject('plan diverges from persisted dispatch intent');
  }
  return Object.freeze({action_id:body.action_id,issuer_run_id:body.issuer_run_id,
    ticket_sha256:action.receipt.ticket_sha256,state_version:state.version});
}

// Call only from a trusted GitHub API reader, not from Agent-provided JSON.
// Supports dependency injection for deterministic GitHub API fixtures.
export function createGitHubRunReader(token,{api='https://api.github.com',fetchFn=fetch}={}) {
  if (typeof token!=='string' || token.length<8 || typeof fetchFn!=='function') reject('missing trusted read-only GitHub token');
  if (api!=='https://api.github.com') reject('unsupported API origin');
  const request=async path=>{
    const response=await fetchFn(api+'/repos/'+REPOSITORY+path,{
      method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10'}});
    if (!response.ok) reject('GitHub API read failed: '+response.status);
    return response.json();
  };
  return {
    getRun:runId=>{if(!positive(runId))reject('invalid run id');return request('/actions/runs/'+runId);},
    getPullRequest:number=>{if(!positive(number))reject('invalid PR number');return request('/pulls/'+number);},
  };
}
// Only the trusted Coordinator may call this with a token holding Actions:write.
// The signing key is never passed into this client; the Agent receives only
// the already-signed ticket. Requesting run details is now supported by the
// GitHub REST workflow dispatch API; legacy 204 remains a valid *unverified*
// acceptance response and must not be promoted into a made-up Run ID.
export function createGitHubDispatchClient(token,{api='https://api.github.com',fetchFn=fetch,keyring,now=Date.now()}={}) {
  if (typeof token!=='string' || token.length<8 || typeof fetchFn!=='function') {
    reject('missing trusted dispatch credential');
  }
  if (api!=='https://api.github.com') reject('unsupported dispatch API origin');
  return async function dispatch(plan) {
    if (!plan || plan.repository!==REPOSITORY || plan.ref!=='main' ||
        !plan.return_run_details || !Object.values(PROVIDERS).some(x=>x.workflow===plan.workflow_id) ||
        !own(plan.inputs,['action_id','issue_number','agent_id','task','input_sha',
          'dispatch_ticket','resume_from']) ||
        ![6,7].includes(Object.keys(plan.inputs).length) ||
        !HEX64.test(plan.inputs.action_id??'')) {
      reject('invalid or unapproved GitHub dispatch plan');
    }
    const body=verifyDispatchTicket(plan.inputs.dispatch_ticket,keyring,{now});
    if (plan.workflow_id!==PROVIDERS[body.role].workflow ||
        plan.inputs.action_id!==body.action_id ||
        plan.inputs.issue_number!==String(body.issue) ||
        plan.inputs.agent_id!==body.agent_id || plan.inputs.task!==body.task ||
        plan.inputs.input_sha!==body.input_sha ||
        (body.schema_version===2 ?
          plan.inputs.resume_from!==Buffer.from(canonical(body.resume_from)).toString('base64url') :
          Object.hasOwn(plan.inputs,'resume_from'))) {
      reject('dispatch plan does not match the signed Outbox ticket');
    }
    const response=await fetchFn(api+'/repos/'+REPOSITORY+'/actions/workflows/'+
      plan.workflow_id+'/dispatches',{
      method:'POST',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2026-03-10','Content-Type':'application/json'},
      body:JSON.stringify({ref:'main',inputs:plan.inputs,return_run_details:true}),
    });
    if (response.status===204) {
      return {status:'accepted',dispatch_id:plan.inputs.action_id};
    }
    if (response.status!==200) reject('GitHub workflow_dispatch failed: '+response.status);
    const data=await response.json();
    const id=data?.workflow_run_id;
    if (!positive(id) || data.run_url!==
        api+'/repos/'+REPOSITORY+'/actions/runs/'+id) {
      reject('GitHub dispatch response lacks verifiable downstream Run identity');
    }
    return {status:'verified',dispatch_id:plan.inputs.action_id,source_run_id:id};
  };
}

function authenticatedTicketIssuer(run,mainSha) {
  // The original Controller initializer and the new isolated dispatcher are
  // both main-owned authorities. Never accept worker code, PR/fork runs or
  // user-provided result JSON as issuer provenance.
  const allowed = new Map([
    ['.github/workflows/acceptance-agent-controller.yml','Acceptance / Agent Controller'],
    ['.github/workflows/agent-controller-dispatch.yml','Agent / Controller Dispatch'],
  ]);
  return run?.name===allowed.get(run?.path)&&
    ['workflow_dispatch','issue_comment'].includes(run?.event)&&run?.head_branch==='main'&&
    run?.actor?.login==='BestNathan'&&
    run?.repository?.full_name===REPOSITORY&&
    run?.head_repository?.full_name===REPOSITORY&&
    run?.head_sha===mainSha&&positive(run?.id)&&positive(run?.run_attempt);
}

function compareSource(run,body,result) {
  const spec=PROVIDERS[body.role];
  if (!run || run.id!==result.run_id || run.run_attempt!==result.run_attempt ||
      run.path!==spec.path || run.name!==spec.name || run.event!=='workflow_dispatch' ||
      run.head_branch!=='main' || !HEX40.test(run.head_sha??'') ||
      run.repository?.full_name!==REPOSITORY || run.status!=='completed' ||
      run.conclusion!=='success' || result.task_id!==body.action_id ||
      result.issue!==body.issue || result.kind!==body.role ||
      !spec.tasks.includes(body.task) || !HEX40.test(result.target_sha??'')) {
    reject('GitHub Run provenance or Agent outcome mismatch');
  }
  const runCreated=Date.parse(run.created_at ?? '');
  if (!Number.isFinite(runCreated) ||
      runCreated<body.issued_at-30000 ||
      runCreated>body.expires_at+30000) {
    reject('run created outside ticket dispatch window');
  }
}
// GitHub Get Workflow Run does not reliably expose workflow_dispatch inputs.
// Provenance instead binds the authenticated dispatch response's run ID to
// this Outbox action BEFORE the worker's result can be consumed.
export async function attestAgentOutcome({
  state,result,dispatch_ticket,pr_number,registry,reader,keyring,now=Date.now(),
  verified_main_sha,
}) {
  validateDevelopmentState(state);
  if (!own(result,RESULT_FIELDS) || Object.keys(result).length!==RESULT_FIELDS.length ||
      !positive(result.run_id) || !positive(result.run_attempt) ||
      !HEX40.test(verified_main_sha??'')) reject('invalid completion attestation request');
  const body=verifyDispatchTicket(dispatch_ticket,keyring,{now,allowExpired:true});
  if (body.issue!==state.issue || body.state_version>state.version ||
      state.assignments[body.role]!==body.agent_id ||
      registry.instances?.[body.agent_id]?.role!==body.role) {
    reject('ticket is not bound to this Issue/Agent Registry');
  }
  const pending=state.outbox.find(x=>x.id===body.action_id && x.status==='dispatched');
  if (!pending || pending.task.role!==body.role || pending.task.task!==body.task ||
      pending.task.agent_id!==body.agent_id || pending.task.sha!==body.input_sha ||
      pending.receipt?.dispatch_id!==body.action_id ||
      pending.receipt.status!=='verified' ||
      pending.receipt.source_run_id!==result.run_id ||
      (pending.task.continuation ?
        body.schema_version!==2 ||
          canonical(body.resume_from)!==canonical(pending.task.continuation) :
        body.schema_version!==1)) {
    reject('ticket has no trusted run-bound dispatch receipt');
  }
  const issuer=await reader.getRun(body.issuer_run_id);
  if (issuer.id!==body.issuer_run_id ||
      !authenticatedTicketIssuer(issuer,verified_main_sha)) {
    reject('dispatch ticket issuer is not the trusted Controller');
  }
  const run=await reader.getRun(result.run_id);
  compareSource(run,body,result);
  if (run.head_sha!==verified_main_sha) reject('worker did not execute trusted main SHA');
  if (!positive(pr_number)) reject('missing trusted publisher PR identity');
  const pr=await reader.getPullRequest(pr_number);
  if (pr.base?.repo?.full_name!==REPOSITORY || pr.head?.repo?.full_name!==REPOSITORY ||
      pr.state!=='open' || pr.head?.sha!==result.target_sha ||
      pr.number!==pr_number || !pr.head?.ref?.startsWith('agent/issue-'+state.issue+'-')) {
    reject('PR head/branch does not confirm signed Agent output SHA');
  }
  if (body.role==='reviewer' && result.target_sha!==body.input_sha) {
    reject('Reviewer result must refer to the exact reviewed SHA');
  }
  return {
    repository:REPOSITORY,path:run.path,name:run.name,run_id:run.id,
    attempt:run.run_attempt,event:run.event,ref:'refs/heads/main',
    issue:body.issue,task_id:body.action_id,agent_id:body.agent_id,
    input_sha:body.input_sha,output_sha:result.target_sha,verified:true,
  };
}

// Trusted pre-model continuation preflight. The Store checkout and Git ancestry
// are independently verified here; model-provided JSON cannot substitute a
// remote checkpoint commitment. This returns PUBLIC metadata only. Decryption
// and Provider-native Session restoration occur in a separate trusted step.
export function authorizeNativeContinuation({
  state,dispatch_ticket,keyring,remote,now=Date.now(),
}) {
  validateDevelopmentState(state);
  const body=verifyDispatchTicket(dispatch_ticket,keyring,{now});
  if(body.schema_version!==2)reject('native resume requires a signed v2 ticket');
  if(body.issue!==state.issue||state.assignments[body.role]!==body.agent_id)
    reject('resumed ticket belongs to another Issue/Agent');
  const action=state.outbox.find(x=>x.id===body.action_id &&
    ['pending','dispatching','dispatched'].includes(x.status));
  if(!action||action.task.type!=='dispatch'||action.task.resume!==true||
      action.task.role!==body.role||action.task.agent_id!==body.agent_id||
      action.task.task!==body.task||action.task.sha!==body.input_sha||
      canonical(action.task.continuation)!==canonical(body.resume_from))
    reject('signed continuation differs from persisted Outbox');
  const c=body.resume_from;
  const confirmed=verifyCommittedCheckpoint({remote,
    identity:{role:body.role,agent_id:body.agent_id,issue:body.issue},
    commit_sha:c.checkpoint_commit_sha,version:c.checkpoint_version,
    ciphertext_sha256:c.ciphertext_sha256});
  return Object.freeze({issue:body.issue,agent_id:body.agent_id,role:body.role,
    action_id:body.action_id,input_sha:body.input_sha,
    parent_action_id:c.parent_action_id,ordinal:c.ordinal,
    checkpoint_version:confirmed.version,
    checkpoint_commit_sha:confirmed.commit_sha,
    ciphertext_sha256:confirmed.ciphertext_sha256,
    store_ref:confirmed.store_ref,
    current_store_sha:confirmed.current_store_sha});
}

// Trusted Controller/Ingester admission for a completed bounded Worker Slice.
// The only trusted sources are: persisted run-bound Dispatch receipt, independently
// fetched GitHub issuer + Worker Runs, a verified HMAC, and the real remote Git
// checkpoint object. Neither Agent JSON nor comments can set "verified".
export async function acceptAttestedSliceYield({
  state,dispatch_ticket,keyring,reader,remote,checkpoint,
  verified_main_sha,now=Date.now(),
}) {
  validateDevelopmentState(state);
  const body=verifyDispatchTicket(dispatch_ticket,keyring,{now,allowExpired:true});
  if(!HEX40.test(verified_main_sha??'')||
      !own(checkpoint,['version','commit_sha','ciphertext_sha256','run_id','attempt'])||
      Object.keys(checkpoint).length!==5||
      !positive(checkpoint.run_id)||!positive(checkpoint.attempt)) {
    reject('invalid trusted Slice attestation request');
  }
  const old=state.outbox.find(x=>x.id===body.action_id &&
    ['dispatched','yielded'].includes(x.status));
  if(!old||old.task.type!=='dispatch'||old.task.role!==body.role||
      old.task.task!==body.task||old.task.agent_id!==body.agent_id||
      old.task.sha!==body.input_sha||body.issue!==state.issue||
      body.state_version>state.version||
      state.assignments[body.role]!==body.agent_id||
      old.receipt?.dispatch_id!==body.action_id||
      (old.status==='dispatched'&&
        (old.receipt.status!=='verified'||
         old.receipt.source_run_id!==checkpoint.run_id))||
      (old.status==='yielded'&&
        (old.receipt.source_run_id!==checkpoint.run_id||
         old.receipt.source_attempt!==checkpoint.attempt))||
      (old.task.continuation ?
        body.schema_version!==2 ||
          canonical(old.task.continuation)!==canonical(body.resume_from) :
        body.schema_version!==1)) {
    reject('Slice lacks an authenticated run-bound dispatch or signed lineage');
  }
  const issuer=await reader.getRun(body.issuer_run_id);
  if(issuer.id!==body.issuer_run_id||
      !authenticatedTicketIssuer(issuer,verified_main_sha)) {
    reject('Slice issuer is not the trusted Controller Run');
  }
  const run=await reader.getRun(checkpoint.run_id);
  compareSource(run,body,{kind:body.role,issue:body.issue,
    run_id:checkpoint.run_id,run_attempt:checkpoint.attempt,
    target_sha:body.input_sha,task_id:body.action_id});
  if(run.head_repository?.full_name!==REPOSITORY||
      run.head_sha!==verified_main_sha) {
    reject('Slice Worker did not execute authenticated main code');
  }
  verifyCommittedCheckpoint({remote,
    identity:{role:body.role,agent_id:body.agent_id,issue:body.issue},
    commit_sha:checkpoint.commit_sha,version:checkpoint.version,
    ciphertext_sha256:checkpoint.ciphertext_sha256});
  return recordSliceYield(state,state.version,body.action_id,{
    version:checkpoint.version,commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
  },{
    verified:true,repository:REPOSITORY,
    workflow_path:run.path,workflow_name:run.name,role:body.role,
    agent_id:body.agent_id,issue:body.issue,run_id:run.id,
    attempt:run.run_attempt,action_id:body.action_id,input_sha:body.input_sha,
  });
}
