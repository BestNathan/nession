import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{40}$/;
const PHASES = new Set(['ready', 'review', 'repair', 'quality', 'acceptance', 'waiting-merge', 'post-merge-acceptance', 'done', 'blocked']);
const OUTCOMES = {
  developer: new Set(['implementation_ready']),
  reviewer: new Set(['approved', 'changes_requested']),
  quality: new Set(['passed', 'failed']),
  acceptance: new Set(['passed', 'failed', 'pending']),
  merge: new Set(['completed']),
};
function reject(message) { throw new Error('agent orchestration: ' + message); }
function integer(v) { return Number.isInteger(v) && v > 0; }
function eventKey(e) {
  return createHash('sha256').update([e.kind, e.issue, e.run_id, e.run_attempt, e.target_sha, e.outcome].join(':')).digest('hex');
}

// The caller authenticates trusted evidence from the actual workflow run.
// Neither Issue comment content nor the model chooses the next role.
export function advanceWorkflow(state, event, trusted, config = {}) {
  if (!trusted || trusted.workflow_run_id !== event?.run_id ||
      trusted.attempt !== event?.run_attempt || trusted.issue !== event?.issue ||
      trusted.source_sha !== event?.target_sha || trusted.role !== event?.kind) {
    reject('untrusted source provenance');
  }
  if (!integer(event.issue) || !integer(event.run_id) || !integer(event.run_attempt) ||
      !SHA.test(event.target_sha ?? '') || !OUTCOMES[event.kind]?.has(event.outcome)) {
    reject('invalid event envelope');
  }
  if (Object.hasOwn(event, 'next_role') || Object.hasOwn(event, 'nextRole')) reject('model cannot select the next role');
  const current = state ?? { issue: event.issue, phase: 'ready', target_sha: null, repair_attempts: 0, transitions: [] };
  if (!PHASES.has(current.phase) || current.issue !== event.issue || !Array.isArray(current.transitions)) reject('invalid current state');
  const key = eventKey(event);
  if (current.transitions.some((x) => x.key === key)) return { state: current, actions: [], duplicate: true };
  const next = { ...current, transitions: [...current.transitions] };
  const maxRepairs = config.max_repairs ?? 3;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10) reject('invalid retry policy');
  let actions;
  if (event.kind === 'developer' && event.outcome === 'implementation_ready' &&
      ['ready', 'repair'].includes(current.phase)) {
    next.phase = 'review';
    next.target_sha = event.target_sha;
    actions = [{ type: 'dispatch', role: 'reviewer', task: 'review', sha: event.target_sha }];
  } else if (event.kind === 'reviewer' && current.phase === 'review' && current.target_sha === event.target_sha) {
    if (event.outcome === 'changes_requested') {
      next.repair_attempts++;
      next.phase = next.repair_attempts > maxRepairs ? 'blocked' : 'repair';
      actions = next.phase === 'blocked' ? [{ type: 'notify', reason: 'repair_limit' }] :
        [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }];
    } else {
      next.phase = 'quality';
      actions = [{ type: 'verify', gate: 'quality', sha: event.target_sha }];
    }
  } else if (event.kind === 'quality' && current.phase === 'quality' && current.target_sha === event.target_sha) {
    if (event.outcome === 'passed') {
      next.phase = 'acceptance';
      // Existing Acceptance Orchestrator selects each SC by target and proof method.
      actions = [{ type: 'verify', gate: 'sc-acceptance', when: 'pr', sha: event.target_sha }];
    } else {
      next.phase = 'repair';
      actions = [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }];
    }
  } else if (event.kind === 'acceptance' && current.phase === 'acceptance' && current.target_sha === event.target_sha) {
    next.phase = event.outcome === 'passed' ? 'waiting-merge' : event.outcome === 'failed' ? 'repair' : 'blocked';
    actions = event.outcome === 'passed' ? [{ type: 'notify', reason: 'requires_authorized_merge' }] :
      event.outcome === 'failed' ? [{ type: 'dispatch', role: 'developer', task: 'repair', sha: event.target_sha, resume: true }] :
      [{ type: 'notify', reason: 'acceptance_pending' }];
  } else if (event.kind === 'merge' && current.phase === 'waiting-merge' &&
      event.outcome === 'completed') {
    next.phase = 'post-merge-acceptance';
    next.merged_sha = event.target_sha;
    next.target_sha = event.target_sha;
    actions = [{ type: 'verify', gate: 'sc-acceptance', when: 'merged', sha: event.target_sha }];
  } else if (event.kind === 'acceptance' && current.phase === 'post-merge-acceptance' &&
      current.target_sha === event.target_sha) {
    next.phase = event.outcome === 'passed' ? 'done' : 'blocked';
    actions = event.outcome === 'passed' ? [] :
      [{ type: 'notify', reason: event.outcome === 'pending' ? 'merged_acceptance_pending' : 'merged_acceptance_failed' }];
  } else {
    reject('stale SHA or illegal state transition: ' + current.phase + ' / ' + event.kind);
  }
  next.transitions.push({ key, kind: event.kind, run_id: event.run_id, attempt: event.run_attempt,
    target_sha: event.target_sha, outcome: event.outcome });
  return { state: next, actions, duplicate: false };
}

export function authorizeCommentCommand(comment, authorPermission) {
  if (!['admin', 'maintain', 'write'].includes(authorPermission)) reject('comment author lacks repository write authority');
  const match = /^\/agent (resume developer|review)$/.exec(comment?.trim() ?? '');
  if (!match) reject('unsupported comment command');
  return { command: match[1] === 'review' ? 'review' : 'resume', role: match[1] === 'review' ? 'reviewer' : 'developer' };
}
