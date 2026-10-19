import { createHash } from 'node:crypto';
import { resolveIdentity, validateRegistry } from '../harness/contract.mjs';
import { advanceWorkflow } from './transition.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ROLE_TASK = { developer: ['implement','repair'], reviewer: ['review'], acceptor: ['accept'] };
const SOURCE_WORKFLOW = Object.freeze({
  developer: { path: '.github/workflows/agent-develop.yml', name: 'Agent / Development' },
  reviewer: { path: '.github/workflows/agent-review.yml', name: 'Agent / Review' },
  quality: { path: '.github/workflows/ci-quality.yml', name: 'CI / Quality Gate' },
  acceptance: { path: '.github/workflows/acceptance-orchestrator.yml', name: 'Acceptance / Orchestrator' },
});
const ACTION_TYPES = new Set(['dispatch','verify','notify']);
const STATUSES = new Set(['pending','dispatching','dispatched','yielded']);
const MAX_SLICES = 64;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_OUTBOX = 128;
const MAX_ATTEMPTS = 5;

function reject(message) { throw new Error('agent outbox: ' + message); }
function isIssue(value) { return Number.isSafeInteger(value) && value > 0; }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) reject('invalid ' + label);
}
function boundRole(registry, agentId, role, task) {
  const instance = registry.instances[agentId];
  if (!instance || instance.role !== role) reject('role or ID is not registered');
  return resolveIdentity(registry, agentId, task, instance.environment);
}
function makeAction(issue, version, action, assignments, index) {
  onlyKeys(action, ['type','role','task','sha','resume','gate','when','reason'], 'transition action');
  if (!ACTION_TYPES.has(action.type) || (action.sha != null && !SHA.test(action.sha)) ||
      !Number.isSafeInteger(version) || version < 1) reject('invalid transition action');
  const role = action.role ?? null;
  if (action.type === 'dispatch' && (!ROLE_TASK[role]?.includes(action.task) || !assignments[role])) {
    reject('unexpected dispatch role/task');
  }
  if (action.type === 'verify' && !['quality','sc-acceptance'].includes(action.gate)) {
    reject('unexpected verification gate');
  }
  if (action.type === 'notify' && typeof action.reason !== 'string') reject('unexpected notification');
  const target = {
    ...action, agent_id: role && assignments[role] || null,
  };
  const id = hash([issue, version, index, target]);
  return { id, task: target, status: 'pending', attempts: 0, receipt: null };
}
export function validateDevelopmentState(state) {
  onlyKeys(state, ['schema_version','issue','version','phase','target_sha','repair_attempts',
    'transitions','outbox','assignments','merged_sha'], 'state');
  if (state.schema_version !== 1 || !isIssue(state.issue) || !positive(state.version) ||
      !['ready','review','repair','quality','acceptance','waiting-merge',
        'post-merge-acceptance','done','blocked'].includes(state.phase) ||
      !Number.isSafeInteger(state.repair_attempts) || state.repair_attempts < 0 ||
      !Array.isArray(state.transitions) || !Array.isArray(state.outbox) ||
      state.outbox.length > MAX_OUTBOX || (state.target_sha != null && !SHA.test(state.target_sha))) {
    reject('invalid state shape');
  }
  if (state.merged_sha != null && !SHA.test(state.merged_sha)) reject('invalid merged SHA');
  onlyKeys(state.assignments, ['developer','reviewer','acceptor'], 'role assignments');
  for (const role of ['developer','reviewer','acceptor']) {
    if (typeof state.assignments[role] !== 'string' ||
        !/^[a-z][a-z0-9-]{1,80}$/.test(state.assignments[role])) reject('missing agent assignment');
  }
  const ids = new Set();
  for (const item of state.outbox) {
    onlyKeys(item, ['id','task','status','attempts','receipt'], 'outbox entry');
    if (!/^[a-f0-9]{64}$/.test(item.id) || ids.has(item.id) || !STATUSES.has(item.status) ||
        !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > MAX_ATTEMPTS) {
      reject('invalid/duplicate outbox entry');
    }
    ids.add(item.id);
    onlyKeys(item.task, ['type','role','task','sha','resume','gate','when','reason','agent_id',
      'continuation'], 'outbox action');
    if (item.task.continuation != null) {
      const c=item.task.continuation;
      onlyKeys(c,['parent_action_id','ordinal','checkpoint_version','checkpoint_commit_sha',
        'ciphertext_sha256'], 'Slice continuation');
      const parent=state.outbox.find(x=>x.id===c.parent_action_id && x.status==='yielded');
      if(item.task.type!=='dispatch'||item.task.resume!==true||
          !HEX64.test(c.parent_action_id??'')||!positive(c.ordinal)||c.ordinal>MAX_SLICES||
          !positive(c.checkpoint_version)||!SHA.test(c.checkpoint_commit_sha??'')||
          !HEX64.test(c.ciphertext_sha256??'') || !parent ||
          c.ordinal!==(parent.task.continuation?.ordinal??0)+1 ||
          c.checkpoint_version!==parent.receipt.checkpoint_version ||
          c.checkpoint_commit_sha!==parent.receipt.checkpoint_commit_sha ||
          c.ciphertext_sha256!==parent.receipt.ciphertext_sha256 ||
          item.task.role!==parent.task.role ||
          item.task.agent_id!==parent.task.agent_id ||
          item.task.task!==parent.task.task ||
          item.task.sha!==parent.task.sha ||
          item.id!==hash([c.parent_action_id,c.checkpoint_version,
            c.ordinal,c.checkpoint_commit_sha]) ||
          state.outbox.filter(x=>x.task.continuation?.parent_action_id===parent.id).length!==1) {
        reject('unbound or invalid Slice continuation');
      }
    }
    if (!ACTION_TYPES.has(item.task.type)) reject('unknown action');
    if (item.status === 'dispatching') {
      const receipt=item.receipt;
      onlyKeys(receipt,['status','dispatch_id','issuer_run_id',
        'ticket_sha256'], 'write-ahead dispatch intent');
      if(Object.keys(receipt).length!==4||receipt.status!=='prepared'||
          receipt.dispatch_id!==item.id||!positive(receipt.issuer_run_id)||
          !HEX64.test(receipt.ticket_sha256??'')||
          item.task.type!=='dispatch'||item.attempts<1) {
        reject('invalid persisted dispatch intent');
      }
    } else if (item.status === 'dispatched') {
      if (!item.receipt || !plain(item.receipt) ||
          !['accepted','verified'].includes(item.receipt.status) ||
          item.receipt.dispatch_id !== item.id ||
          (item.receipt.status === 'verified' && !positive(item.receipt.source_run_id))) {
        reject('missing acknowledged dispatch receipt');
      }
    } else if (item.status === 'yielded') {
      const c=item.receipt;
      onlyKeys(c,['status','dispatch_id','source_run_id','source_attempt',
        'checkpoint_version','checkpoint_commit_sha','ciphertext_sha256'], 'yield receipt');
      if(c.status!=='yielded'||c.dispatch_id!==item.id||
          !positive(c.source_run_id)||!positive(c.source_attempt)||
          !positive(c.checkpoint_version)||!SHA.test(c.checkpoint_commit_sha??'')||
          !HEX64.test(c.ciphertext_sha256??'')||item.task.type!=='dispatch') {
        reject('invalid committed Slice yield receipt');
      }
    } else if (item.receipt !== null) reject('unacknowledged item has receipt');
  }
  return state;
}
// The caller independently authenticates the workflow_dispatch actor via GitHub.
// An Issue comment body, Agent tool response, or fork-originated event cannot
// be passed as the start authority.
export function startDevelopment(registry, request, authority) {
  validateRegistry(registry);
  onlyKeys(request, ['issue','sha','developer','reviewer','acceptor'], 'start request');
  if (!isIssue(request.issue) || !SHA.test(request.sha ?? '') ||
      !authority || authority.repository !== 'BestNathan/nession' ||
      authority.event !== 'workflow_dispatch' || authority.permission !== 'write' ||
      authority.ref !== 'refs/heads/main' || !positive(authority.run_id)) {
    reject('unauthorized start request');
  }
  const assignments = {};
  for (const role of ['developer','reviewer','acceptor']) {
    boundRole(registry, request[role], role, ROLE_TASK[role][0]);
    assignments[role] = request[role];
  }
  const state = {
    schema_version: 1, issue: request.issue, version: 1, phase: 'ready',
    target_sha: null, repair_attempts: 0, transitions: [], assignments,
    outbox: [makeAction(request.issue,1,
      { type:'dispatch',role:'developer',task:'implement',sha:request.sha },assignments,0)],
  };
  return validateDevelopmentState(state);
}
function expectedSource(state, result, source) {
  onlyKeys(result, ['kind','issue','run_id','run_attempt','target_sha','outcome','task_id'], 'task result');
  const expected = SOURCE_WORKFLOW[result.kind];
  if (!expected || !positive(result.run_id) || !positive(result.run_attempt) ||
      !isIssue(result.issue) || result.issue !== state.issue || !SHA.test(result.target_sha ?? '')) {
    reject('invalid result or source kind');
  }
  onlyKeys(source, ['repository','path','name','run_id','attempt','event','ref',
    'issue','task_id','agent_id','input_sha','output_sha','verified'], 'trusted source');
  if (source.verified !== true || source.repository !== 'BestNathan/nession' ||
      source.ref !== 'refs/heads/main' || source.path !== expected.path ||
      source.name !== expected.name || source.event !== 'workflow_dispatch' &&
      source.event !== 'pull_request' && source.event !== 'workflow_run' ||
      source.run_id !== result.run_id || source.attempt !== result.run_attempt ||
      source.issue !== result.issue || source.task_id !== result.task_id ||
      source.output_sha !== result.target_sha || !SHA.test(source.input_sha ?? '')) {
    reject('untrusted or mismatched source');
  }
  const candidates = state.outbox.filter(item =>
    item.id === result.task_id && item.status === 'dispatched');
  if (candidates.length !== 1) reject('task has not been dispatched or was already consumed');
  const previous = candidates[0];
  const expectedKind = previous.task.type === 'dispatch' ? previous.task.role :
    previous.task.gate === 'quality' ? 'quality' :
    previous.task.gate === 'sc-acceptance' ? 'acceptance' : null;
  // The native worker must echo this deterministic action ID in its runtime
  // inputs; a GitHub workflow_dispatch HTTP 204 contains no downstream run_id.
  if (previous.receipt?.dispatch_id !== result.task_id) reject('dispatch binding missing');
  if (result.kind !== expectedKind || source.input_sha !== previous.task.sha) {
    reject('result is not for the outstanding role or exact source SHA');
  }
  if (previous.task.type === 'dispatch' &&
      (source.agent_id !== state.assignments[result.kind] ||
       previous.task.agent_id !== source.agent_id)) reject('wrong Agent instance');
  if (previous.task.type === 'verify' && source.agent_id != null) reject('verification may not impersonate Agent');
  return previous;
}
export function acceptTaskResult(state, expectedVersion, result, source, registry) {
  validateDevelopmentState(state);
  validateRegistry(registry);
  if (expectedVersion !== state.version) reject('stale state CAS');
  const task = expectedSource(state,result,source);
  if (state.transitions.some(x => x.run_id === result.run_id && x.attempt === result.run_attempt &&
      x.kind === result.kind)) reject('source run already consumed');
  const attest = { workflow_run_id: result.run_id, attempt: result.run_attempt,
    issue: result.issue, source_sha: result.target_sha, role: result.kind };
  const advanced = advanceWorkflow(state,result,attest);
  if (advanced.duplicate) reject('duplicate event with inconsistent task correlation');
  const version = state.version + 1;
  // Immutable previous workflow states retain the audit trail. Once an
  // authenticated final Task result is consumed, prune its bounded chain of
  // yielded Slices so it cannot fill the Outbox or leave stale continuations.
  const completed = new Set([task.id]);
  let parentId=task.task.continuation?.parent_action_id;
  for(let i=0;parentId && i<MAX_SLICES;i++){
    const parent=state.outbox.find(x=>x.id===parentId);
    if(!parent || parent.status!=='yielded'||completed.has(parentId))
      reject('broken prior Slice lineage');
    completed.add(parentId);
    parentId=parent.task.continuation?.parent_action_id;
  }
  if(parentId)reject('exhausted Slice lineage');
  const outbox = advanced.state.outbox.filter(x => !completed.has(x.id));
  if (outbox.length + advanced.actions.length > MAX_OUTBOX) reject('outbox size limit exceeded');
  const spawned = advanced.actions.map((a,i) => {
    const entry = makeAction(state.issue,version,a,state.assignments,i);
    if (entry.task.type === 'dispatch') {
      boundRole(registry,entry.task.agent_id,entry.task.role,entry.task.task);
    }
    return entry;
  });
  return validateDevelopmentState({
    ...advanced.state, schema_version:1, version, outbox:[...outbox,...spawned],
  });
}
// Persist this transition *before* any non-idempotent workflow_dispatch API
// call. A crash after GitHub accepts but before its HTTP response is ambiguous:
// reconciliation must authenticate the original downstream Run, NEVER replay
// the POST from a write-ahead intent. Immutable prior state versions preserve
// the original unsigned pending action and its signed ticket hash.
export function recordDispatchIntent(state,expectedVersion,actionId,intent) {
  validateDevelopmentState(state);
  if(expectedVersion!==state.version)reject('stale state CAS');
  onlyKeys(intent,['status','dispatch_id','issuer_run_id','ticket_sha256'],
    'write-ahead intent');
  if(Object.keys(intent).length!==4||intent.status!=='prepared'||
      intent.dispatch_id!==actionId||!positive(intent.issuer_run_id)||
      !HEX64.test(intent.ticket_sha256??''))reject('invalid write-ahead intent');
  const item=state.outbox.find(x=>x.id===actionId);
  if(!item||item.task.type!=='dispatch')reject('write-ahead action missing');
  if(item.status==='dispatching'){
    if(JSON.stringify(item.receipt)!==JSON.stringify(intent))
      reject('conflicting write-ahead dispatch intent');
    return state;
  }
  if(item.status!=='pending')reject('write-ahead action not pending');
  if(item.attempts>=MAX_ATTEMPTS)reject('retry limit reached');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x=>x.id===actionId?{
      ...x,status:'dispatching',attempts:x.attempts+1,receipt:intent,
    }:x)});
}

export function recordDispatch(state, expectedVersion, actionId, receipt) {
  validateDevelopmentState(state);
  if (expectedVersion !== state.version) reject('stale state CAS');
  const old = state.outbox.find(item => item.id === actionId);
  if (!old) reject('outbox action absent');
  // A receipt is generated by a trusted dispatcher after the target API
  // accepted the dispatch. Never trust a model-generated receipt.
  onlyKeys(receipt,['status','dispatch_id','source_run_id'], 'dispatch receipt');
  if (!['accepted','verified'].includes(receipt.status) || receipt.dispatch_id !== actionId ||
      (receipt.status === 'verified' && !positive(receipt.source_run_id)) ||
      (receipt.status === 'accepted' && receipt.source_run_id != null)) {
    reject('invalid trusted dispatch receipt');
  }
  if (old.status === 'dispatched') {
    if (JSON.stringify(old.receipt) !== JSON.stringify(receipt)) reject('conflicting receipt');
    return state; // repeat confirmation of the same dispatch is idempotent
  }
  if (!['pending','dispatching'].includes(old.status))
    reject('cannot dispatch a yielded or nonpending action');
  if (old.attempts >= MAX_ATTEMPTS && old.status==='pending')
    reject('retry limit reached');
  return validateDevelopmentState({
    ...state,version: state.version+1,
    outbox:state.outbox.map(item => item.id === actionId ? {
      ...item,status:'dispatched',attempts:item.attempts+(item.status==='pending'?1:0),receipt,
    } : item),
  });
}

// A bounded Worker may end at a Provider-safe checkpoint without declaring the
// Issue task complete. Caller MUST authenticate GitHub Run/Attempt/Artifact and
// verify that the checkpoint has already been committed at the remote Store SHA.
// This pure transition never writes a ref or mints a workflow dispatch token.
export function recordSliceYield(state,expectedVersion,actionId,checkpoint,source) {
  validateDevelopmentState(state);
  if (state.version!==expectedVersion) reject('stale state CAS');
  const old=state.outbox.find(item=>item.id===actionId);
  if (!old || old.task.type!=='dispatch') reject('Slice action absent or is not an Agent dispatch');
  onlyKeys(checkpoint,['version','commit_sha','ciphertext_sha256'], 'checkpoint receipt');
  onlyKeys(source,['verified','repository','workflow_path','workflow_name','role','agent_id',
    'issue','run_id','attempt','action_id','input_sha'], 'authenticated Slice source');
  if(!positive(checkpoint.version)||!SHA.test(checkpoint.commit_sha??'')||
      !HEX64.test(checkpoint.ciphertext_sha256??'')) reject('invalid committed checkpoint identity');
  const expected=SOURCE_WORKFLOW[old.task.role];
  if(source.verified!==true||source.repository!=='BestNathan/nession'||
      source.workflow_path!==expected?.path||source.workflow_name!==expected?.name||
      source.role!==old.task.role||source.agent_id!==old.task.agent_id||
      source.issue!==state.issue||source.action_id!==actionId||
      source.input_sha!==old.task.sha||!positive(source.run_id)||!positive(source.attempt))
    reject('untrusted or mismatched Slice source');
  if(old.receipt?.status==='verified' && old.receipt.source_run_id!==source.run_id)
    reject('Slice is not the acknowledged dispatched Run');
  const receipt={
    status:'yielded',dispatch_id:actionId,source_run_id:source.run_id,
    source_attempt:source.attempt,checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
  };
  // A lost acknowledgement can be adopted by the original authenticated Run.
  // Divergent or stale attempts must never spawn another continuation.
  if(old.status==='yielded'){
    if(JSON.stringify(old.receipt)!==JSON.stringify(receipt))
      reject('conflicting committed Slice yield');
    return state;
  }
  if(old.status!=='dispatched'||!['accepted','verified'].includes(old.receipt?.status))
    reject('Slice must yield from an acknowledged dispatch');
  const prior=old.task.continuation;
  const ordinal=(prior?.ordinal??0)+1;
  if(ordinal>MAX_SLICES||
      checkpoint.version!==(prior?.checkpoint_version??0)+1)
    reject('noncontiguous or exhausted Slice checkpoint');
  if(state.outbox.length>=MAX_OUTBOX)reject('outbox size limit exceeded');
  const continuation={
    parent_action_id:actionId,ordinal,checkpoint_version:checkpoint.version,
    checkpoint_commit_sha:checkpoint.commit_sha,
    ciphertext_sha256:checkpoint.ciphertext_sha256,
  };
  const nextId=hash([actionId,checkpoint.version,ordinal,checkpoint.commit_sha]);
  if(state.outbox.some(item=>item.id===nextId))reject('duplicate Slice continuation identity');
  const next={
    id:nextId,task:{...old.task,resume:true,continuation},
    status:'pending',attempts:0,receipt:null,
  };
  return validateDevelopmentState({
    ...state,version:state.version+1,
    outbox:[...state.outbox.map(item=>item.id===actionId?{...item,status:'yielded',receipt}:item),next],
  });
}

export function failedDispatch(state, expectedVersion, actionId) {
  validateDevelopmentState(state);
  if (state.version !== expectedVersion) reject('stale state CAS');
  const old = state.outbox.find(x => x.id === actionId);
  if (!old || old.status !== 'pending' || old.attempts >= MAX_ATTEMPTS) reject('cannot retry dispatched/exhausted task');
  return validateDevelopmentState({...state,version:state.version+1,
    outbox:state.outbox.map(x => x.id === actionId ? {...x,attempts:x.attempts+1} : x)});
}
export function reconcileOutbox(state) {
  validateDevelopmentState(state);
  return {
    pending:state.outbox.filter(x => x.status === 'pending' && x.attempts < MAX_ATTEMPTS),
    exhausted:state.outbox.filter(x => x.status === 'pending' && x.attempts >= MAX_ATTEMPTS),
    awaiting_evidence:state.outbox.filter(x => x.status === 'dispatched'),
    awaiting_dispatch_receipt:state.outbox.filter(x => x.status === 'dispatching'),
    yielded:state.outbox.filter(x => x.status === 'yielded'),
  };
}
