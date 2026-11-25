// Issue #4525 — fair, bounded active-lifecycle scan.
//
// The scan only reads existing durable states. It never creates a lifecycle,
// never starts an unauthorized Issue and never lets one malformed or slow
// candidate starve the rest of the Store. Rotation is deterministic over the
// raw candidate set, so repeated bounded ticks cover every entry.
import fs from 'node:fs';
import path from 'node:path';
import { validateLifecycleState } from './contract.mjs';
import { validateDevelopmentState } from '../orchestration/outbox.mjs';

const DEFAULT_MAX_ISSUES = 20;
const DEFAULT_MAX_HEADS = 2000;
const MAX_MALFORMED = 32;
const ACTIVE_EXECUTION = new Set([
  'pending', 'dispatching', 'dispatched', 'claimed', 'executing',
  'result_available', 'ambiguous',
]);

function reject(message) {
  throw new Error('agent workflow scan: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function issueHead(root, issue) {
  const file = path.join(root, 'workflows', 'issues', String(issue), 'head.json');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) {
    return null;
  }
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!positive(record?.version)) return null;
    return record;
  } catch {
    return null;
  }
}
function listHeads(root, maxHeads) {
  const directory = path.join(root, 'workflows', 'issues');
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject('unsafe Issue state root');
  const names = fs.readdirSync(directory);
  if (names.length > maxHeads) {
    reject('Issue state directory exceeds the bounded head inventory');
  }
  return names
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
}

function classifyState(state) {
  if (state?.schema_version === 2) {
    validateLifecycleState(state);
    const unresolved = state.outbox.filter((action) =>
      ACTIVE_EXECUTION.has(action.status)).length;
    const terminal = ['done', 'cancelled'].includes(state.phase);
    if (terminal && unresolved === 0) return null;
    return {
      schema_version: 2,
      phase: state.phase,
      blocked: state.phase === 'blocked',
      unresolved,
      legacy: false,
    };
  }
  if (state?.schema_version === 1) {
    validateDevelopmentState(state);
    if (state.phase === 'done') return null;
    const unresolved = state.outbox.filter((action) =>
      ['pending', 'dispatching', 'dispatched'].includes(action.status)).length;
    return {
      schema_version: 1,
      phase: state.phase,
      blocked: state.phase === 'blocked',
      unresolved,
      legacy: true,
    };
  }
  return null;
}

// loadState(issue) is supplied by the caller (local Store or trusted remote
// projection). It must return {state, version} or throw for a malformed entry.
export function scanLifecycleCandidates({
  storeRoot, loadState, cursor = 0, maxIssues = DEFAULT_MAX_ISSUES,
  maxHeads = DEFAULT_MAX_HEADS,
}) {
  if (typeof storeRoot !== 'string' || !fs.statSync(storeRoot).isDirectory()) {
    reject('trusted Store root required');
  }
  if (typeof loadState !== 'function') reject('state loader required');
  if (!nonNegative(cursor)) reject('invalid scan cursor');
  if (!positive(maxIssues) || maxIssues > 100) reject('invalid Issue budget');
  if (!positive(maxHeads) || maxHeads > 20000) reject('invalid head budget');
  const heads = listHeads(storeRoot, maxHeads);
  if (heads.length === 0) {
    return {
      schema_version: 1,
      kind: 'agent_workflow_v2_scan',
      issues: [],
      next_cursor: 0,
      inspected: 0,
      skipped: 0,
      malformed: [],
    };
  }
  const start = cursor % heads.length;
  const budget = Math.min(maxIssues, heads.length);
  const issues = [];
  const malformed = [];
  let inspected = 0;
  for (let offset = 0; offset < budget; offset++) {
    const issue = heads[(start + offset) % heads.length];
    inspected++;
    let loaded;
    try {
      loaded = loadState(issue);
    } catch {
      if (malformed.length < MAX_MALFORMED) {
        malformed.push({ issue, reason: 'unreadable_state' });
      }
      continue;
    }
    if (loaded?.state == null) continue;
    let classification;
    try {
      classification = classifyState(loaded.state);
    } catch {
      if (malformed.length < MAX_MALFORMED) {
        malformed.push({ issue, reason: 'invalid_state' });
      }
      continue;
    }
    if (classification == null) continue;
    // Re-check the head after loading so a concurrent rewrite cannot smuggle
    // a mismatched version into the scan result.
    const head = issueHead(storeRoot, issue);
    if (head == null || head.version !== loaded.version) {
      if (malformed.length < MAX_MALFORMED) {
        malformed.push({ issue, reason: 'head_changed_during_scan' });
      }
      continue;
    }
    issues.push({ issue, ...classification, version: loaded.version });
  }
  return {
    schema_version: 1,
    kind: 'agent_workflow_v2_scan',
    issues,
    // Advance over the raw candidate set even when many entries were skipped,
    // so a stable set is fully observed within ceil(n / maxIssues) ticks.
    next_cursor: (start + budget) % heads.length,
    inspected,
    skipped: inspected - issues.length,
    malformed,
  };
}

// Deterministic rotation seed for stateless scheduled callers. A caller that
// persists next_cursor should pass it explicitly instead.
export function rotationSeed(value = 0) {
  const seed = Number(value);
  return Number.isSafeInteger(seed) && seed >= 0 ? seed : 0;
}
