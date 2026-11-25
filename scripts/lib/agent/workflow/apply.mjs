// Issue #4526 — trusted apply composition for Agent Workflow V2.
//
// This module composes the existing trusted primitives; it does not add a
// privileged writer, queue or model executor. Plan is the default and cannot
// mutate. Apply requires an explicit, fail-closed activation and a complete
// scoped effect composition. A wake can request work; it cannot authorize a
// start, apply, merge or SC verdict.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLifecycleState, validateLifecycleState } from './contract.mjs';
import { normalizeReconcileWake, reconcileOnce } from './reconcile.mjs';
import { readIssueWorkflowState, writeIssueWorkflowState } from '../orchestration/state-store.mjs';
import { auditStagedRunStore } from '../../../run-store-integrity.mjs';
import { publish as publishGitCAS } from '../../../run-store-cas-push.mjs';

const REF = 'agent-store';
const STRICT_FIELDS = ['mode', 'description'];
const EFFECT_METHODS = [
  'prepareDispatch', 'dispatch', 'readbackDispatch',
  'preparePublish', 'publish', 'readbackPublish',
  'prepareAccept', 'accept', 'readbackAccept',
  'notify', 'retryCi', 'readbackCiRetry', 'reingest',
];
const START_KEYS = ['issue', 'base_sha', 'developer_sha', 'developer',
  'reviewer', 'acceptor', 'authority'];
const WAKE_ONLY_FORBIDDEN = ['authorize', 'start', 'apply', 'merge', 'sc',
  'pass', 'store', 'writer', 'dispatch', 'publish', 'token', 'credential'];

function reject(message) {
  throw new Error('agent workflow apply: ' + message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function onlyKeys(value, allowed, label) {
  if (value == null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    reject('invalid ' + label);
  }
}
function git(root, args, allowFailure = false) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1' },
    }).trim();
  } catch {
    if (allowFailure) return null;
    reject('git ' + args[0] + ' failed');
  }
}
function cloneStore(remote) {
  if (typeof remote !== 'string' || !remote.trim() || /\s/.test(remote)) {
    reject('trusted Store remote required');
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-apply-v2-'));
  const checkout = path.join(parent, 'store');
  try {
    execFileSync('git', ['clone', '--no-tags', '--single-branch', '--branch', REF,
      '--', remote, checkout], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (git(checkout, ['symbolic-ref', '--short', 'HEAD']) !== REF) {
      reject('not an agent-store checkout');
    }
    return { parent, checkout };
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    if (error.message.startsWith('agent workflow apply:')) throw error;
    reject('authenticated agent-store ref unavailable');
  }
}

// ── real Store CAS port ─────────────────────────────────────────────────
// The port clones the trusted orphan ref, re-reads it for every CAS and uses
// the existing non-force run-store publisher. A local write without a verified
// remote advance is never reported as success.
export function createRemoteStorePort({
  remote, maxAttempts = 4, onCandidate = null, keepCheckout = false,
}) {
  const { parent, checkout } = cloneStore(remote);
  let closed = false;
  const sync = () => {
    git(checkout, ['fetch', '--no-tags', '--depth=96', 'origin',
      'refs/heads/' + REF]);
    const remoteHead = git(checkout, ['rev-parse', 'FETCH_HEAD']);
    const localHead = git(checkout, ['rev-parse', 'HEAD']);
    if (remoteHead !== localHead) git(checkout, ['reset', '--hard', remoteHead]);
    return remoteHead;
  };
  const port = {
    kind: 'agent_workflow_v2_remote_store',
    capabilities: { load: true, cas: true, remoteRefCas: true },
    async load(issue) {
      if (closed) reject('closed Store port');
      sync();
      const record = readIssueWorkflowState(checkout, issue);
      return { state: record.state, version: record.version, digest: record.digest };
    },
    async cas(state, expectedVersion) {
      if (closed) reject('closed Store port');
      validateLifecycleState(state);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        reject('invalid expected Store version');
      }
      sync();
      const current = readIssueWorkflowState(checkout, state.issue);
      if (current.version !== expectedVersion) return { conflict: true };
      if (state.version !== expectedVersion + 1) reject('non-contiguous apply write');
      writeIssueWorkflowState(checkout, state, expectedVersion);
      git(checkout, ['add', '-A']);
      const audit = auditStagedRunStore(checkout, REF);
      if (audit.checked_changes === 0) reject('empty apply candidate');
      git(checkout, ['-c', 'user.name=nession-agent-reconcile',
        '-c', 'user.email=nession-agent-reconcile@users.noreply.github.com',
        'commit', '-m', 'agent-store: reconcile Issue ' + state.issue +
          ' v' + state.version]);
      if (onCandidate != null) {
        if (process.env.NODE_ENV !== 'test') reject('candidate injection is test-only');
        onCandidate({ checkout, state });
      }
      try {
        const published = publishGitCAS(REF, checkout, maxAttempts);
        if (typeof published?.commit_sha !== 'string' ||
            !/^[a-f0-9]{40}$/.test(published.commit_sha)) {
          reject('unverifiable Store commit');
        }
        return {
          version: state.version,
          commit_sha: published.commit_sha,
          replayed: published.replayed === true,
        };
      } catch {
        // A competing writer or a lost acknowledgement is a conflict for this
        // attempt; the caller must reload and re-observe.
        return { conflict: true };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!keepCheckout) fs.rmSync(parent, { recursive: true, force: true });
    },
  };
  return port;
}

// ── scoped effect composition ───────────────────────────────────────────
// Adapters are injected by the trusted bootstrap. They must reuse the existing
// signed dispatch, Publisher, Acceptance and notification owners; this module
// validates the boundary and never supplies model credentials.
export function createScopedEffects(adapters) {
  if (adapters == null || typeof adapters !== 'object' || Array.isArray(adapters)) {
    reject('invalid effect adapters');
  }
  for (const [key, value] of Object.entries(adapters)) {
    if (!EFFECT_METHODS.includes(key)) {
      if (/model|provider|api_?key|private_?key|token|credential|secret/i.test(key)) {
        reject('model/credential material cannot enter the effects port');
      }
      if (!STRICT_FIELDS.includes(key)) reject('unexpected effect adapter ' + key);
      continue;
    }
    if (typeof value !== 'function') reject('effect adapter must be a function');
  }
  for (const method of EFFECT_METHODS) {
    if (typeof adapters[method] !== 'function') {
      reject('missing effect adapter ' + method);
    }
  }
  return Object.freeze({ ...adapters });
}

export function assertScopedComposition(composition) {
  if (composition == null || typeof composition !== 'object') {
    reject('invalid apply composition');
  }
  const serialized = JSON.stringify(Object.keys(composition));
  if (/model|provider|api_?key|private_?key|credential|secret/i.test(serialized)) {
    reject('apply composition exposes privileged material');
  }
  return composition;
}

// ── fail-closed activation and authorized start ────────────────────────
function requireActivation(activation, capability) {
  if (activation == null || typeof activation !== 'object' || Array.isArray(activation) ||
      activation.enabled !== true || activation[capability] !== true) {
    reject(capability + ' is not activated');
  }
  if (activation.explicitSelection !== true) {
    reject('explicit authorized selection is required');
  }
  return activation;
}

export function createAuthorizedStart({
  store, registry, activation, now = Date.now(),
}) {
  if (store == null || typeof store.load !== 'function' ||
      typeof store.cas !== 'function') {
    reject('writable Store port required for start');
  }
  return async function start(request) {
    requireActivation(activation, 'v2Start');
    onlyKeys(request, START_KEYS, 'start request');
    const state = createLifecycleState({
      registry, issue: request.issue, base_sha: request.base_sha,
      developer_sha: request.developer_sha,
      developer: request.developer, reviewer: request.reviewer,
      acceptor: request.acceptor, authority: request.authority, now,
    });
    const existing = await store.load(state.issue);
    if (existing.state != null) {
      // A v1 or v2 lifecycle already owns this Issue. Never create a second
      // engine or reset history.
      reject('Issue already has a durable lifecycle');
    }
    const written = await store.cas(state, 0);
    if (written?.conflict) reject('initial Store CAS conflict');
    return {
      issue: state.issue,
      version: written?.version ?? state.version,
      thread_id: state.thread.id,
      action_id: state.outbox[0].id,
    };
  };
}

// ── unified wake router ─────────────────────────────────────────────────
export function createWakeRouter({
  reconcile, start = null, activation, maxInFlight = 32,
}) {
  if (typeof reconcile !== 'function') reject('reconcile function required');
  const inFlight = new Set();
  return async function route(wake = {}) {
    const issueHint = wake.issue ?? (Array.isArray(wake.issues) ? wake.issues[0] : null);
    const normalized = normalizeReconcileWake({
      source: wake.source,
      reason: wake.reason,
      correlation_id: wake.correlation_id ?? null,
      issues: wake.issues ?? (issueHint == null ? [] : [issueHint]),
    });
    const issue = normalized.issues[0] ?? issueHint ?? null;
    if (wake.issue != null && !positive(wake.issue)) reject('invalid wake Issue');
    if (normalized.source === 'external') {
      for (const key of Object.keys(wake)) {
        if (WAKE_ONLY_FORBIDDEN.includes(key)) {
          reject('external wake is wake-only and cannot authorize ' + key);
        }
      }
    }
    if (wake.start != null || wake.authorize != null || wake.apply != null) {
      // A wake hint is never an authorization or a start request.
      if (normalized.source !== 'manual') {
        reject('only an authenticated manual command may request start/apply');
      }
      if (wake.start != null) {
        requireActivation(activation, 'v2Start');
        if (typeof start !== 'function') reject('start composition absent');
        onlyKeys(wake.start, START_KEYS, 'start request');
        if (issue != null && wake.start.issue !== issue) {
          reject('start request/Issue mismatch');
        }
        return start(wake.start);
      }
    }
    const apply = activation?.enabled === true && activation?.apply === true;
    if (wake.apply === true && !apply) reject('apply is not activated');
    const key = String(issue ?? 'scan') + '\u0000' + normalized.reason;
    if (inFlight.has(key)) return { coalesced: true, issue };
    if (inFlight.size >= maxInFlight) reject('wake coalescer is full');
    inFlight.add(key);
    try {
      return await reconcile({
        issue,
        wake: normalized,
        apply,
      });
    } finally {
      inFlight.delete(key);
    }
  };
}

// ── apply composition ──────────────────────────────────────────────────
export function createApplyComposition({
  store, effects = null, observer, activation, registry = null,
  config = {}, now = Date.now(),
}) {
  if (store == null || typeof store.load !== 'function') reject('Store port required');
  if (observer == null || typeof observer.observe !== 'function') {
    reject('observer required');
  }
  const apply = activation?.enabled === true && activation?.apply === true;
  if (apply) {
    if (effects == null) reject('apply requires the scoped effect composition');
    assertScopedComposition(effects);
  }
  const ports = { store, observer, effects: apply ? effects : null };
  const runtime = {
    mode: apply ? 'apply' : 'plan',
    async reconcile({ issue, wake, apply: requested = apply }) {
      if (requested && !apply) reject('apply is not activated');
      return reconcileOnce({
        issue, wake, ports, config, now, apply: requested,
      });
    },
    async start(request) {
      const start = createAuthorizedStart({
        store, registry, activation, now,
      });
      return start(request);
    },
    route(wake) {
      const router = createWakeRouter({
        reconcile: runtime.reconcile, start: runtime.start, activation,
      });
      return router(wake);
    },
    async close() {
      if (typeof store.close === 'function') await store.close();
    },
  };
  return assertScopedComposition(runtime);
}

// A production composition is deliberately refused until the trusted bootstrap
// injects the existing signed dispatch/Publisher/Acceptance adapters and an
// explicit activation. A missing binding is not silently replaced.
export function createProductionApplyComposition(bindings = {}) {
  const { store, effects, observer, registry, activation } = bindings;
  if (store == null || effects == null || observer == null || registry == null) {
    reject('production apply composition is not activated: trusted bindings missing');
  }
  requireActivation(activation, 'apply');
  return createApplyComposition({
    store, effects: createScopedEffects(effects), observer, registry, activation,
  });
}
