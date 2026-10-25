// #2345: durable singleflight projection for authenticated E2E failures.
// The caller must authenticate the source Run/Attempt/artifact before entry.
// This module owns no credentials, GitHub API calls, Agent execution, or Issue writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint, decideAdmission } from '../../../e2e-failure-admission.mjs';

const REPO = 'BestNathan/nession';
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const POSITIVE = n => Number.isSafeInteger(n) && n > 0;
const ROOT = 'e2e-failures';
function fail(message) { throw new Error('e2e failure ledger: ' + message); }
function bytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + '\n'); }
function hash(value) { return createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex'); }
function keyFor(fingerprintValue) {
  if (typeof fingerprintValue !== 'string' || !/^e2e1:[a-f0-9]{64}$/.test(fingerprintValue)) fail('invalid fingerprint');
  return fingerprintValue.slice(5);
}
function checkedDir(root, relative) {
  let current = path.resolve(root);
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe Store root');
  for (const segment of relative.split('/').filter(Boolean)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(segment) || segment === '.' || segment === '..') fail('unsafe Store path');
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe Store directory');
    } else fs.mkdirSync(current);
  }
  return current;
}
function readJson(root, relative, maxBytes = 256 * 1024) {
  const parent = checkedDir(root, path.posix.dirname(relative));
  const filename = path.join(parent, path.posix.basename(relative));
  if (!fs.existsSync(filename)) return null;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail('unsafe ledger file');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('corrupt ledger JSON'); }
}
function putOnce(root, relative, value) {
  const parent = checkedDir(root, path.posix.dirname(relative));
  const filename = path.join(parent, path.posix.basename(relative));
  const content = bytes(value);
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(filename).equals(content)) {
      fail('immutable ledger collision');
    }
    return false;
  }
  fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
  return true;
}
function validateAuthenticatedObservation(o) {
  if (!o || o.authenticated !== true || o.source?.repository !== REPO ||
      o.source?.workflow_path !== '.github/workflows/e2e-full-regression.yml' ||
      o.source?.event !== 'schedule' || o.source?.branch !== 'main' ||
      o.source?.conclusion !== 'failure' || !Number.isFinite(Date.parse(o.source?.completed_at ?? '')) || !POSITIVE(o.source?.run_id) ||
      !POSITIVE(o.source?.run_attempt) || !HEX40.test(o.source?.target_sha ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(o.artifact?.digest ?? '') ||
      !POSITIVE(o.artifact?.id) || !Array.isArray(o.results) || o.results.length > 64) {
    fail('observation lacks independently authenticated exact-run provenance');
  }
  const ids = new Set();
  for (const r of o.results) {
    if (!r || typeof r.test_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(r.test_id) ||
        ids.has(r.test_id) || typeof r.kind !== 'string') fail('invalid/duplicate per-ID observation');
    ids.add(r.test_id);
  }
}
function paths(digest, run, attempt) {
  return {
    root: ROOT + '/' + digest,
    head: ROOT + '/' + digest + '/head.json',
    state: version => ROOT + '/' + digest + '/states/' + String(version).padStart(8, '0') + '.json',
    observation: 'e2e-failure-observations/' + run + '-' + attempt + '-' + digest + '.json',
  };
}
function validateState(s, digest) {
  if (!s || s.schema_version !== 1 || s.kind !== 'e2e_failure_admission_state' ||
      s.fingerprint !== 'e2e1:' + digest || !POSITIVE(s.version) || !POSITIVE(s.epoch) ||
      !['claimed', 'in_flight', 'analyzed', 'issue_linked', 'retryable_failure', 'resolved'].includes(s.status) ||
      typeof s.lease_expires_at !== 'string' || !Number.isFinite(Date.parse(s.lease_expires_at)) ||
      typeof s.analysis_id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(s.analysis_id)) {
    fail('invalid admission state');
  }
  if (s.dispatch_intent && (s.dispatch_intent.id !== s.analysis_id ||
      !['pending', 'committed', 'reconcile', 'acknowledged'].includes(s.dispatch_intent.status))) {
    fail('invalid durable dispatch intent');
  }
  return s;
}
function readCurrent(root, p, digest) {
  const head = readJson(root, p.head, 8192);
  if (!head) return { state: null, version: 0 };
  if (!POSITIVE(head.version) || head.path !== p.state(head.version) || !HEX64.test(head.sha256 ?? '')) {
    fail('invalid ledger CAS head');
  }
  const state = validateState(readJson(root, head.path), digest);
  if (state.version !== head.version || hash(bytes(state)) !== head.sha256) fail('ledger head digest mismatch');
  return { state, version: head.version };
}
function writeState(root, p, previousVersion, state) {
  const current = readCurrent(root, p, keyFor(state.fingerprint));
  if (current.version !== previousVersion || state.version !== previousVersion + 1) fail('stale ledger CAS version');
  putOnce(root, p.state(state.version), state);
  const head = { version: state.version, path: p.state(state.version), sha256: hash(bytes(state)) };
  const parent = checkedDir(root, p.root);
  const tmp = path.join(parent, '.head-' + state.version + '-' + process.pid);
  fs.writeFileSync(tmp, bytes(head), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, path.join(parent, 'head.json'));
}
function appendObservation(root, p, observation, fingerprintValue, outcome, now) {
  const record = {
    schema_version: 1, kind: 'e2e_failure_admission_observation',
    source: observation.source,
    artifact: { id: observation.artifact.id, digest: observation.artifact.digest },
    fingerprint: fingerprintValue ?? null,
    classification: observation.classification,
    observed_at: observation.source.completed_at,
    result_ids: observation.results.map(x => x.test_id),
    acceptance_record_path: observation.source.acceptance_record_path ?? null,
    failure_signatures: observation.results.map(x => ({
      test_id: x.test_id,
      kind: x.kind,
      actionable: x.actionable === true,
      signature: x.actionable === true ? {
        assertion_code: x.assertion_code,
        stable_frame: x.stable_frame,
        affected_invariant: x.affected_invariant,
        environment_specific: x.environment_specific === true,
      } : null,
    })),
    // Only the trusted allowlisted signature fields survive; no assertion text,
    // stack, trace, stdout, title, URL or model-authored text is persisted.
  };
  const pth = p.observation;
  putOnce(root, pth, record);
  return pth;
}

// One invocation records the observation and decides the durable singleflight outcome.
// The remote agent-store CAS publisher must commit this working tree; a CAS conflict
// means re-read latest Store and re-run this function, never blindly dispatch.
export function recordE2EFailureObservation(root, observation, {
  now = new Date().toISOString(), leaseMs = 15 * 60 * 1000,
  linkedIssue = null,
} = {}) {
  validateAuthenticatedObservation(observation);
  if (!Number.isFinite(Date.parse(now)) || !Number.isSafeInteger(leaseMs) ||
      leaseMs < 60_000 || leaseMs > 24 * 60 * 60 * 1000) fail('invalid clock or lease');
  const nowMs = Date.parse(now);
  const actionable = observation.classification === 'product_assertion_failure' ||
    observation.classification === 'actionable_test_timeout' ||
    observation.classification === 'candidate_test_failure';
  const representative = observation.results.find(x => x.actionable === true);
  const fp = actionable && representative ? fingerprint({
    test_id: representative.test_id, kind: representative.kind,
    assertion_code: representative.assertion_code, stable_frame: representative.stable_frame,
    affected_invariant: representative.affected_invariant,
    environment_specific: representative.environment_specific,
    environment_id: representative.environment_id,
  }) : { status: 'INSUFFICIENT_SIGNATURE', reason: 'failure is not classified as actionable product evidence' };
  if (fp.status !== 'FINGERPRINTED') {
    const unknownKey = hash([observation.source.run_id, observation.source.run_attempt, observation.source.target_sha]);
    const p = paths(unknownKey, observation.source.run_id, observation.source.run_attempt);
    const outcome = { action: 'TRIAGE_REQUIRED', reason: fp.reason };
    const observationPath = appendObservation(root, p, observation, null, outcome, nowMs);
    return { status: 'TRIAGE_REQUIRED', fingerprint: null, observation_path: observationPath, dispatch_allowed: false };
  }

  const digest = keyFor(fp.fingerprint);
  const p = paths(digest, observation.source.run_id, observation.source.run_attempt);
  const current = readCurrent(root, p, digest);
  const decision = decideAdmission(current.state, fp, new Date(nowMs).toISOString(), linkedIssue);
  const observationPath = appendObservation(root, p, observation, fp.fingerprint, decision, nowMs);
  let state = current.state;
  if (['CLAIM_NEW', 'RETRY_SAME_TASK', 'CLAIM_RECURRENCE', 'LINK_EXISTING_BUG_NO_AGENT'].includes(decision.action)) {
    const epoch = decision.epoch;
    const analysisId = digest + ':' + epoch;
    state = {
      schema_version: 1, kind: 'e2e_failure_admission_state', fingerprint: fp.fingerprint,
      version: current.version + 1, epoch,
      status: decision.action === 'LINK_EXISTING_BUG_NO_AGENT' ? 'issue_linked' : 'claimed',
      analysis_id: analysisId,
      lease_expires_at: new Date(nowMs + leaseMs).toISOString(),
      dispatch_intent: { id: analysisId, status: decision.action === 'LINK_EXISTING_BUG_NO_AGENT' ? 'acknowledged' : 'pending' },
      bug_issue: decision.bug_issue ?? decision.prior_bug_issue ?? null,
      first_source: current.state?.first_source ?? {
        run_id: observation.source.run_id, run_attempt: observation.source.run_attempt,
        target_sha: observation.source.target_sha,
      },
      latest_observation: { run_id: observation.source.run_id, run_attempt: observation.source.run_attempt,
        target_sha: observation.source.target_sha },
      prior_bug_issue: decision.prior_bug_issue ?? null,
    };
    writeState(root, p, current.version, state);
  }
  const typed = {
    CLAIM_NEW: 'ANALYSIS_CLAIMED',
    RECONCILE_EXPIRED_CLAIM: 'ADMISSION_RECONCILE_REQUIRED',
    RETRY_SAME_TASK: 'ANALYSIS_CLAIMED',
    CLAIM_RECURRENCE: 'ANALYSIS_CLAIMED',
    REUSE_ANALYSIS: current.state?.status === 'claimed' || current.state?.status === 'in_flight'
      ? 'ANALYSIS_IN_FLIGHT' : 'ANALYSIS_REUSED',
    LINK_EXISTING_BUG_NO_AGENT: 'ANALYSIS_REUSED',
    TRIAGE_REQUIRED: 'TRIAGE_REQUIRED',
    ERROR: 'ADMISSION_ERROR',
  }[decision.action] ?? 'ADMISSION_ERROR';
  return { status: typed, fingerprint: fp.fingerprint, analysis_id: state?.analysis_id ?? null,
    epoch: state?.epoch ?? decision.epoch ?? null, expected_version: current.version,
    observation_path: observationPath, dispatch_allowed: false, decision };
}

// Read the current admission projection for one fingerprint. The caller must
// still hold the Store CAS head; a conflict means re-read, never blind dispatch.
export function readFailureAdmission(root, fingerprintValue) {
  const digest = keyFor(fingerprintValue);
  const p = paths(digest, 0, 0);
  const current = readCurrent(root, p, digest);
  return { state: current.state, version: current.version };
}

// Read the observation that justified the current claim (sanitized fields
// only). The dispatcher uses it to build the bounded Agent request.
export function readFailureObservation(root, fingerprintValue, runId, runAttempt) {
  const digest = keyFor(fingerprintValue);
  if (!POSITIVE(runId) || !POSITIVE(runAttempt)) fail('invalid observation identity');
  const relative = paths(digest, runId, runAttempt).observation;
  const record = readJson(root, relative);
  if (!record || record.kind !== 'e2e_failure_admission_observation' ||
      record.fingerprint !== fingerprintValue) fail('missing or mismatched observation record');
  return record;
}

// A dispatch POST succeeded but the downstream run could not be observed yet
// (GitHub has no dispatch response body). The intent becomes `reconcile`: no
// further POST may happen until a run search proves the original never landed.
export function markFailureDispatchAmbiguous(root, fingerprintValue, {
  now = new Date().toISOString(),
} = {}) {
  if (!Number.isFinite(Date.parse(now))) fail('invalid dispatch clock');
  const digest = keyFor(fingerprintValue);
  const p = paths(digest, 0, 0);
  const current = readCurrent(root, p, digest);
  const state = current.state;
  if (!state) fail('unknown fingerprint admission');
  if (state.status !== 'claimed' && state.status !== 'in_flight') {
    fail('admission is not dispatchable: ' + state.status);
  }
  if (state.dispatch_intent?.status !== 'pending') fail('dispatch intent is not pending');
  const next = {
    ...state,
    version: current.version + 1,
    dispatch_intent: { ...state.dispatch_intent, status: 'reconcile' },
  };
  writeState(root, p, current.version, next);
  return { state: next, version: next.version };
}

// Write-ahead dispatch intent: the claim exists BEFORE the external dispatch.
// This transition commits that intent with the exact downstream run identity.
// A crash after the HTTP POST but before this write is reconciled by adopting
// the downstream run that already carries the analysis id.
export function recordFailureDispatchCommitted(root, fingerprintValue, {
  now = new Date().toISOString(), runId, runAttempt, leaseMs = 60 * 60 * 1000,
} = {}) {
  if (!Number.isFinite(Date.parse(now))) fail('invalid dispatch clock');
  if (!POSITIVE(runId) || !POSITIVE(runAttempt)) fail('invalid dispatch run identity');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 24 * 60 * 60 * 1000) {
    fail('invalid dispatch lease');
  }
  const digest = keyFor(fingerprintValue);
  const p = paths(digest, runId, runAttempt);
  const current = readCurrent(root, p, digest);
  const state = current.state;
  if (!state) fail('unknown fingerprint admission');
  if (state.status !== 'claimed' && state.status !== 'in_flight') {
    fail('admission is not dispatchable: ' + state.status);
  }
  if (state.dispatch_intent?.status === 'committed' || state.dispatch_intent?.status === 'acknowledged') {
    fail('dispatch intent is already committed');
  }
  const next = {
    ...state,
    version: current.version + 1,
    status: 'in_flight',
    dispatch_intent: { ...state.dispatch_intent, status: 'committed', run_id: runId, run_attempt: runAttempt },
    dispatch_run: { run_id: runId, run_attempt: runAttempt },
    lease_expires_at: new Date(Date.parse(now) + leaseMs).toISOString(),
  };
  writeState(root, p, current.version, next);
  return { state: next, version: next.version };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? '/tmp', 'e2e-failure-ledger-'));
  try {
    const sha = 'a'.repeat(40), digestValue = 'b'.repeat(64);
    const observation = {
      authenticated: true,
      source: { repository: REPO, workflow_path: '.github/workflows/e2e-full-regression.yml',
        event: 'schedule', branch: 'main', conclusion: 'failure', run_id: 501,
        run_attempt: 1, target_sha: sha, completed_at: '2026-10-24T11:59:00Z' },
      artifact: { id: 77, digest: 'sha256:' + digestValue },
      classification: 'product_assertion_failure',
      results: [{ test_id: 'terminal-attach', kind: 'assertion_failed', actionable: true,
        assertion_code: 'expected terminal buffer continuity', stable_frame: 'web/src/terminal/attach.ts:resume',
        affected_invariant: 'terminal-buffer-continuity' }],
    };
    const first = recordE2EFailureObservation(root, observation, { now: '2026-10-24T12:00:00Z' });
    assert.equal(first.status, 'ANALYSIS_CLAIMED');
    assert.equal(first.dispatch_allowed, false);
    assert.equal(first.epoch, 1);
    assert.equal(fs.existsSync(path.join(root, first.observation_path)), true);
    assert.equal(fs.existsSync(path.join(root, 'e2e-failures', first.fingerprint.slice(5), 'head.json')), true);
    const repeated = recordE2EFailureObservation(root, { ...observation,
      source: { ...observation.source, run_id: 502, target_sha: 'c'.repeat(40) } },
    { now: '2026-10-24T12:01:00Z' });
    assert.equal(repeated.status, 'ANALYSIS_IN_FLIGHT');
    assert.equal(repeated.analysis_id, first.analysis_id);
    assert.equal(repeated.epoch, 1);
    assert.equal(fs.existsSync(path.join(root, repeated.observation_path)), true);
    const replay = recordE2EFailureObservation(root, observation, { now: '2026-10-24T12:04:00Z' });
    assert.equal(replay.status, 'ANALYSIS_IN_FLIGHT');
    assert.equal(replay.analysis_id, first.analysis_id, 'same Run/Attempt replay must not create a second analysis');
    const ledgerDir = path.join(root, 'e2e-failures', first.fingerprint.slice(5));
    const headFile = path.join(ledgerDir, 'head.json');
    const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
    const stateFile = path.join(root, head.path);
    const expiredState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expiredState.lease_expires_at = '2026-10-24T11:00:00.000Z';
    fs.writeFileSync(stateFile, bytes(expiredState));
    head.sha256 = hash(bytes(expiredState));
    fs.writeFileSync(headFile, bytes(head));
    const expired = recordE2EFailureObservation(root, { ...observation, source: {
      ...observation.source, run_id: 505 } }, { now: '2026-10-24T12:05:00Z' });
    assert.equal(expired.status, 'ADMISSION_RECONCILE_REQUIRED');
    assert.equal(expired.analysis_id, first.analysis_id);
    assert.equal(JSON.parse(fs.readFileSync(headFile, 'utf8')).version, 1,
      'expired lease must not advance claim or mint a second dispatch intent');
    const nonActionable = recordE2EFailureObservation(root, { ...observation, source: {
      ...observation.source, run_id: 503 }, classification: 'setup_or_ci_error' },
    { now: '2026-10-24T12:02:00Z' });
    assert.equal(nonActionable.status, 'TRIAGE_REQUIRED');
    assert.equal(nonActionable.dispatch_allowed, false);
    assert.throws(() => recordE2EFailureObservation(root, { ...observation,
      authenticated: false }, { now: '2026-10-24T12:03:00Z' }), /authenticated/);
    const badSha = { ...observation, source: { ...observation.source, run_id: 504, target_sha: 'main' } };
    assert.throws(() => recordE2EFailureObservation(root, badSha, { now: '2026-10-24T12:03:00Z' }), /authenticated/);
    console.log('e2e-failure-ledger self-test: PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1]?.endsWith('e2e-failure-ledger.mjs')) {
  try { if (process.argv[2] !== 'self-test') throw new Error('usage: self-test'); selfTest(); }
  catch (error) { console.error('e2e-failure-ledger: ' + error.message); process.exitCode = 2; }
}
