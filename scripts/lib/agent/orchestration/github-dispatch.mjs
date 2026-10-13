import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveIdentity } from '../harness/contract.mjs';
import { validateDevelopmentState } from './outbox.mjs';

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
function validBody(body) {
  if (!own(body,BODY_FIELDS) || Object.keys(body).length !== BODY_FIELDS.length ||
      body.schema_version !== 1 || body.repository !== REPOSITORY || !positive(body.issue) ||
      !HEX64.test(body.action_id ?? '') || !positive(body.state_version) ||
      !PROVIDERS[body.role]?.tasks.includes(body.task) || !ID.test(body.agent_id ?? '') ||
      !HEX40.test(body.input_sha ?? '') || !positive(body.issuer_run_id) ||
      !ID.test(body.key_id ?? '') || !Number.isSafeInteger(body.issued_at) ||
      !Number.isSafeInteger(body.expires_at) ||
      body.expires_at <= body.issued_at ||
      body.expires_at - body.issued_at > MAX_TTL_MS) reject('invalid dispatch ticket body');
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
  const body=validBody({schema_version:1,repository:REPOSITORY,issue:state.issue,
    action_id:action.id,state_version:state.version,role:t.role,agent_id:t.agent_id,
    task:t.task,input_sha:t.sha,issuer_run_id,issued_at:now,expires_at:now+ttl_ms,key_id});
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
    inputs:{action_id:body.action_id,issue_number:String(body.issue),agent_id:body.agent_id,
      task:body.task,input_sha:body.input_sha,dispatch_ticket:ticket},
  };
}
// Call only from a trusted GitHub API reader, not from Agent-provided JSON.
// Supports dependency injection for deterministic GitHub API fixtures.
export function createGitHubRunReader(token,{api='https://api.github.com',fetchFn=fetch}={}) {
  if (typeof token!=='string' || token.length<8 || typeof fetchFn!=='function') reject('missing trusted read-only GitHub token');
  if (api!=='https://api.github.com') reject('unsupported API origin');
  const request=async path=>{
    const response=await fetchFn(api+'/repos/'+REPOSITORY+path,{
      method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'}});
    if (!response.ok) reject('GitHub API read failed: '+response.status);
    return response.json();
  };
  return {
    getRun:runId=>{if(!positive(runId))reject('invalid run id');return request('/actions/runs/'+runId);},
    getPullRequest:number=>{if(!positive(number))reject('invalid PR number');return request('/pulls/'+number);},
  };
}
function compareSource(run,body,result) {
  const runInput=run.inputs;
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
  if (!runInput || runInput.action_id!==body.action_id ||
      runInput.issue_number!==String(body.issue) || runInput.agent_id!==body.agent_id ||
      runInput.task!==body.task || runInput.input_sha!==body.input_sha) {
    reject('GitHub Run dispatch inputs mismatch');
  }
  if (typeof run.created_at!=='string' ||
      Date.parse(run.created_at)<body.issued_at-30000 ||
      Date.parse(run.created_at)>body.expires_at+30000) {
    reject('run created outside ticket dispatch window');
  }
}
// Inputs are fetched on the same GitHub API run object. Missing inputs fail
// closed; a future signed artifact path must verify artifact ownership/digest
// before it can substitute for unavailable GitHub run inputs.
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
      pending.receipt?.dispatch_id!==body.action_id) reject('ticket does not match a dispatched task');
  const issuer=await reader.getRun(body.issuer_run_id);
  if (issuer.id!==body.issuer_run_id ||
      issuer.path!=='.github/workflows/acceptance-agent-controller.yml' ||
      issuer.name!=='Acceptance / Agent Controller' ||
      issuer.repository?.full_name!==REPOSITORY || issuer.event!=='workflow_dispatch' ||
      issuer.head_branch!=='main' || issuer.head_sha!==verified_main_sha) {
    reject('dispatch ticket issuer is not the trusted Controller');
  }
  const run=await reader.getRun(result.run_id);
  compareSource(run,body,result);
  if (run.head_sha!==verified_main_sha) reject('worker did not execute trusted main SHA');
  if (typeof run.inputs.dispatch_ticket!=='string' ||
      run.inputs.dispatch_ticket!==dispatch_ticket) reject('worker used a different dispatch ticket');
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
