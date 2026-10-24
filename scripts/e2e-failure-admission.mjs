#!/usr/bin/env node
// Owner: #2327. Deterministic pre-Agent logical failure dedup policy.
// This is a pure policy owner, NOT a GitHub writer, credentialed dispatcher,
// deployment attestor, or source-of-truth Run Store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const KIND = new Set(['assertion_failed', 'test_timeout', 'harness_error', 'environment_error']);
const LIVE = new Set(['claimed', 'in_flight', 'analyzed', 'issue_linked']);

// Remove event-specific values without weakening meaningful error categories.
// It is safer to refuse a weak signature than suppress a distinct real defect.
export function normalizeSignature(value) {
  return String(value ?? '').slice(0, 1024).toLowerCase()
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}t[0-9:.+-]+z?/g, '<time>')
    .replace(/\b[0-9a-f]{40,64}\b/g, '<sha>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/(?:run|attempt|pid|port|request)[-_ ]?(?:id|number)?[:=# ]+[0-9]+/g, '<volatile>')
    .replace(/\/tmp\/[a-z0-9._/-]+/g, '<tmp>')
    .replace(/\s+/g, ' ').trim();
}

export function fingerprint(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return { status: 'INSUFFICIENT_SIGNATURE', reason: 'not a typed failure observation' };
  }
  const { test_id: id, kind, assertion_code: code, stable_frame: frame,
    affected_invariant: invariant, environment_specific: environmentSpecific,
    environment_id: environmentId } = observation;
  if (!TEST_ID.test(String(id ?? '')) || !KIND.has(kind)) {
    return { status: 'INSUFFICIENT_SIGNATURE', reason: 'unknown test ID or failure kind' };
  }
  const normalized = [code, frame, invariant].map(normalizeSignature);
  // Generic 500/timeout/test ID alone cannot safely identify one root cause.
  if (normalized.filter(x => x.length >= 6).length < 2 ||
      (normalized[0] === 'timeout' && !normalized[1])) {
    return { status: 'INSUFFICIENT_SIGNATURE', reason: 'missing discriminating failure anchors' };
  }
  if (environmentSpecific === true && !TEST_ID.test(String(environmentId ?? ''))) {
    return { status: 'INSUFFICIENT_SIGNATURE', reason: 'missing environment scope' };
  }
  const fields = [String(id), kind, ...normalized,
    environmentSpecific === true ? String(environmentId) : 'product-global'];
  const digest = createHash('sha256').update(JSON.stringify(['e2e-failure-v1', ...fields])).digest('hex');
  return { status: 'FINGERPRINTED', fingerprint: 'e2e1:' + digest, scope: fields.at(-1) };
}

// A trusted store worker MUST CAS the returned expected_version before dispatch.
// Repeated observations are always appended to the immutable E2E Run history,
// even when an analysis has already occurred.
export function decideAdmission(existing, incoming, now, linkedIssue = null) {
  if (incoming?.status !== 'FINGERPRINTED' || !/^e2e1:[0-9a-f]{64}$/.test(incoming.fingerprint ?? '')) {
    return { action: 'TRIAGE_REQUIRED', reason: 'insufficient normalized failure identity' };
  }
  if (existing == null && linkedIssue != null) {
    // Trusted GitHub Issue discovery can link a manually created, already open
    // Bug *before* any model dispatch. Never accept an Issue's unverified prose
    // or approximate title match as proof that fingerprints are identical.
    if (linkedIssue.verified !== true ||
        linkedIssue.fingerprint !== incoming.fingerprint ||
        !Number.isSafeInteger(linkedIssue.issue_number) || linkedIssue.issue_number < 1) {
      return { action: 'TRIAGE_REQUIRED', reason: 'existing Bug match not authenticated' };
    }
    if (linkedIssue.state === 'open') {
      return { action: 'LINK_EXISTING_BUG_NO_AGENT', epoch: 1, expected_version: null,
        bug_issue: linkedIssue.issue_number };
    }
    // Closed Bugs require verified-fix history for a new epoch, not a blanket
    // model suppression merely because a similarly named old Issue exists.
    return { action: 'TRIAGE_REQUIRED', reason: 'closed Bug needs recurrence policy' };
  }
  if (existing == null) return { action: 'CLAIM_NEW', epoch: 1, expected_version: null };
  if (existing.fingerprint !== incoming.fingerprint) {
    return { action: 'TRIAGE_REQUIRED', reason: 'conflicting stored fingerprint' };
  }
  if (!Number.isSafeInteger(existing.version) || existing.version < 1 ||
      !Number.isSafeInteger(existing.epoch) || existing.epoch < 1) {
    return { action: 'ERROR', reason: 'corrupt admission ledger' };
  }
  const expected = existing.version;
  if (LIVE.has(existing.status)) {
    if (existing.status === 'in_flight' || existing.status === 'claimed') {
      const lease = Date.parse(existing.lease_expires_at ?? '');
      if (!Number.isFinite(lease)) return { action: 'ERROR', reason: 'missing durable lease' };
      if (new Date(now).getTime() > lease) {
        return { action: 'RECONCILE_EXPIRED_CLAIM', epoch: existing.epoch,
          expected_version: expected };
      }
    }
    return { action: 'REUSE_ANALYSIS', epoch: existing.epoch, expected_version: expected,
      analysis_id: existing.analysis_id ?? null, bug_issue: existing.bug_issue ?? null };
  }
  if (existing.status === 'retryable_failure') {
    return { action: 'RETRY_SAME_TASK', epoch: existing.epoch, expected_version: expected };
  }
  if (existing.status === 'resolved') {
    // "resolved" can only be published from a verified fix; a new real failure
    // is a recurrence. The trusted projector reopens same-invariant Bugs.
    if (existing.verified_fix !== true) return { action: 'ERROR', reason: 'unverified resolution' };
    return { action: 'CLAIM_RECURRENCE', epoch: existing.epoch + 1,
      expected_version: expected, prior_bug_issue: existing.bug_issue ?? null };
  }
  return { action: 'ERROR', reason: 'unknown analysis lifecycle state' };
}

function selfTest() {
  const a = { test_id: 'terminal-attach', kind: 'assertion_failed',
    assertion_code: 'Expected Terminal render buffer to equal 42, run=123',
    stable_frame: 'web/src/terminal/Terminal.tsx:render',
    affected_invariant: 'terminal-buffer-continuity',
    environment_id: 'staging-01' };
  const first = fingerprint(a);
  assert.equal(first.status, 'FINGERPRINTED');
  const repeat = fingerprint({ ...a, environment_id: 'staging-02',
    assertion_code: 'Expected Terminal render buffer to equal 42, run=456',
    run_id: 9999, sha: 'b'.repeat(40) });
  assert.equal(repeat.fingerprint, first.fingerprint);
  assert.notEqual(fingerprint({ ...a, assertion_code: 'Expected WS to reconnect on retry' }).fingerprint,
    first.fingerprint);
  assert.notEqual(fingerprint({ ...a, stable_frame: 'crates/nession/src/session.rs:poll' }).fingerprint,
    first.fingerprint);
  assert.notEqual(fingerprint({ ...a, environment_specific: true, environment_id: 'staging-01' }).fingerprint,
    fingerprint({ ...a, environment_specific: true, environment_id: 'staging-02' }).fingerprint);
  assert.equal(fingerprint({ test_id: 'terminal-attach', kind: 'test_timeout',
    assertion_code: 'timeout' }).status, 'INSUFFICIENT_SIGNATURE');

  const now = '2026-10-24T12:00:00Z';
  assert.deepEqual(decideAdmission(null, first, now),
    { action: 'CLAIM_NEW', epoch: 1, expected_version: null });
  assert.deepEqual(decideAdmission(null, first, now, {
    fingerprint: first.fingerprint, state: 'open', verified: true, issue_number: 142 }),
  { action: 'LINK_EXISTING_BUG_NO_AGENT', epoch: 1, expected_version: null, bug_issue: 142 });
  assert.equal(decideAdmission(null, first, now, {
    fingerprint: first.fingerprint, state: 'open', verified: false, issue_number: 142 }).action,
    'TRIAGE_REQUIRED');
  assert.equal(decideAdmission(null, first, now, {
    fingerprint: first.fingerprint, state: 'closed', verified: true, issue_number: 142 }).action,
    'TRIAGE_REQUIRED');
  assert.equal(decideAdmission(null, first, now, {
    fingerprint: 'e2e1:' + 'f'.repeat(64), state: 'open', verified: true,
    issue_number: 142 }).action, 'TRIAGE_REQUIRED');
  const stored = { fingerprint: first.fingerprint, version: 2, epoch: 1,
    status: 'analyzed', analysis_id: 'analysis-01', bug_issue: 1234 };
  assert.equal(decideAdmission(stored, repeat, now).action, 'REUSE_ANALYSIS');
  assert.equal(decideAdmission({ ...stored, status: 'issue_linked' }, repeat, now).action,
    'REUSE_ANALYSIS');
  assert.equal(decideAdmission({ ...stored, status: 'in_flight',
    lease_expires_at: '2026-10-24T13:00:00Z' }, repeat, now).action, 'REUSE_ANALYSIS');
  assert.equal(decideAdmission({ ...stored, status: 'in_flight',
    lease_expires_at: '2026-10-24T11:00:00Z' }, repeat, now).action,
    'RECONCILE_EXPIRED_CLAIM');
  assert.equal(decideAdmission({ ...stored, status: 'retryable_failure' }, repeat, now).action,
    'RETRY_SAME_TASK');
  assert.deepEqual(decideAdmission({ ...stored, status: 'resolved', verified_fix: true }, repeat, now),
    { action: 'CLAIM_RECURRENCE', epoch: 2, expected_version: 2, prior_bug_issue: 1234 });
  assert.equal(decideAdmission({ ...stored, status: 'resolved', verified_fix: false },
    repeat, now).action, 'ERROR');
  assert.equal(decideAdmission({ ...stored, fingerprint: 'e2e1:' + 'f'.repeat(64) },
    repeat, now).action, 'TRIAGE_REQUIRED');
  assert.equal(decideAdmission(stored, { status: 'INSUFFICIENT_SIGNATURE' }, now).action,
    'TRIAGE_REQUIRED');
  console.log('e2e-failure-admission self-test: PASS');
}
try {
  if (process.argv[1]?.endsWith('e2e-failure-admission.mjs')) {
    if (process.argv[2] !== 'self-test') throw new Error('usage: self-test');
    selfTest();
  }
} catch (error) {
  console.error('e2e-failure-admission: ' + error.message);
  process.exitCode = 2;
}
