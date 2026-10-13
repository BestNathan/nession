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
const STATUSES = new Set(['pending','dispatched']);
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
    onlyKeys(item.task, ['type','role','task','sha','resume','gate','when','reason','agent_id'], 'outbox action');
    if (!ACTION_TYPES.has(item.task.type)) reject('unknown action');
    if (item.status === 'dispatched') {
      if (!item.receipt || !plain(item.receipt) ||
          !['accepted','verified'].includes(item.receipt.status) ||
          !positive(item.receipt.source_run_id)) reject('missing acknowledged dispatch receipt');
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
  const outbox = advanced.state.outbox.filter(x => x.id !== task.id);
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
export function recordDispatch(state, expectedVersion, actionId, receipt) {
  validateDevelopmentState(state);
  if (expectedVersion !== state.version) reject('stale state CAS');
  const old = state.outbox.find(item => item.id === actionId);
  if (!old) reject('outbox action absent');
  // A receipt is generated by a trusted dispatcher after the target API
  // accepted the dispatch. Never trust a model-generated receipt.
  onlyKeys(receipt,['status','source_run_id'], 'dispatch receipt');
  if (!['accepted','verified'].includes(receipt.status) || !positive(receipt.source_run_id)) {
    reject('invalid trusted dispatch receipt');
  }
  if (old.status === 'dispatched') {
    if (JSON.stringify(old.receipt) !== JSON.stringify(receipt)) reject('conflicting receipt');
    return state; // repeat confirmation of the same dispatch is idempotent
  }
  if (old.attempts >= MAX_ATTEMPTS) reject('retry limit reached');
  return validateDevelopmentState({
    ...state,version: state.version+1,
    outbox:state.outbox.map(item => item.id === actionId ? {
      ...item,status:'dispatched',attempts:item.attempts+1,receipt,
    } : item),
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
  };
}
