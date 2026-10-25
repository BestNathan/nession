#!/usr/bin/env node
// #2327: trusted-store CLI for Bug publication. It re-validates the stored
// diagnosis against the durable claim, builds the canonical Bug/comment draft
// and records the ledger link. The workflow owns the GitHub Issue write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readFailureAdmission, readFailureObservation, recordE2EFailureObservation,
  recordFailureAnalysisLinked, recordFailureDispatchCommitted,
} from './lib/agent/orchestration/e2e-failure-ledger.mjs';
import { buildAnalysisRequest } from './lib/agent/orchestration/e2e-failure-dispatch.mjs';
import {
  bugDraft, findExistingBug, recurrenceComment, validateDiagnosisForPublication,
} from './lib/agent/publisher/e2e-failure-bug.mjs';
import { e2eFailureAnalysisResult } from './lib/agent/tasks/e2e-failure-analysis.mjs';

function fail(message) { throw new Error('e2e failure analysis publish: ' + message); }

export function plan({ store, fingerprint, analysisRun, diagnosis, issues }) {
  const admission = readFailureAdmission(store, fingerprint);
  const state = admission.state;
  if (!state) fail('unknown fingerprint admission');
  if (!['in_flight', 'analyzed'].includes(state.status)) {
    fail('claim is not awaiting a diagnosis: ' + state.status);
  }
  const dispatched = state.dispatch_run;
  if (!dispatched || dispatched.run_id !== analysisRun?.id || dispatched.run_attempt !== analysisRun?.attempt) {
    fail('analysis run is not the committed dispatch for this claim');
  }
  const latest = state.latest_observation;
  if (!latest) fail('claim has no observation identity');
  const observation = readFailureObservation(store, fingerprint, latest.run_id, latest.run_attempt);
  const request = buildAnalysisRequest({ state, observation });
  const bound = validateDiagnosisForPublication({ diagnosis, request, analysisRun });
  const existing = findExistingBug({ issues, fingerprint });
  if (!existing) {
    const draft = bugDraft({ bound });
    return { action: 'CREATE', fingerprint, analysis_id: bound.analysis_id,
      state_version: admission.version, draft };
  }
  if (!Number.isSafeInteger(existing.number) || existing.number < 1) fail('invalid existing Bug');
  if (!['open', 'closed'].includes(existing.state)) fail('existing Bug state is unknown');
  return { action: existing.state === 'open' ? 'COMMENT' : 'REOPEN',
    fingerprint, analysis_id: bound.analysis_id, state_version: admission.version,
    issue_number: existing.number, comment: recurrenceComment({ bound }) };
}

export function record({ store, fingerprint, analysisId, bugIssue }) {
  const receipt = recordFailureAnalysisLinked(store, fingerprint, { analysisId, bugIssue });
  return { action: 'LINKED', fingerprint, analysis_id: analysisId,
    bug_issue: bugIssue, state_version: receipt.version };
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-failure-publish-'));
  try {
    const now = '2026-10-25T10:00:00Z';
    const observation = {
      authenticated: true,
      source: { repository: 'BestNathan/nession',
        workflow_path: '.github/workflows/e2e-full-regression.yml', event: 'schedule',
        branch: 'main', conclusion: 'failure', run_id: 40170599831, run_attempt: 1,
        target_sha: '1'.repeat(40), completed_at: '2026-10-25T06:51:28Z',
        acceptance_record_path: 'runs/' + '1'.repeat(40) + '/full-regression/40170599831-1.json' },
      artifact: { id: 123, digest: 'sha256:' + 'b'.repeat(64) },
      classification: 'candidate_test_failure',
      results: [{ test_id: 'terminal-attach', kind: 'assertion_failed', actionable: true,
        assertion_code: 'playwright_unexpected',
        stable_frame: 'web/src/terminal/Terminal.spec.ts:42',
        affected_invariant: 'terminal-attach', environment_specific: false }],
    };
    const claim = recordE2EFailureObservation(root, observation, { now });
    const fingerprint = claim.fingerprint;
    recordFailureDispatchCommitted(root, fingerprint, { now, runId: 77, runAttempt: 1 });
    const request = {
      source: { repository: 'BestNathan/nession', workflow_name: 'E2E / Full Regression',
        run_id: 40170599831, run_attempt: 1, target_sha: '1'.repeat(40),
        environment_id: 'main', completed_at: '2026-10-25T06:51:28Z' },
      fingerprint,
      failed_tests: [{ id: 'terminal-attach', kind: 'assertion_failed' }],
      evidence: [{ type: 'log', ref: 'signature:terminal-attach',
        excerpt: 'kind=assertion_failed; frame=web/src/terminal/Terminal.spec.ts:42' }],
      candidate_issues: [],
    };
    const diagnosis = e2eFailureAnalysisResult(request, JSON.stringify({
      failure_category: 'product_regression', failed_test_ids: ['terminal-attach'],
      expected: 'buffer equals 42', actual: 'buffer equals 41',
      evidence: [{ type: 'log', ref: 'signature:terminal-attach', note: 'signature' }],
      suspected_locations: [{ path: 'web/src/terminal/Terminal.tsx', line: 120, reason: 'render' }],
      causal_hypothesis: { summary: 'render truncates the final line', confidence: 'medium', status: 'hypothesis' },
      reproducible_steps: ['attach once'], proposed_regression_test: null,
      candidate_issues: [], unknowns: [],
    }));
    const analysisRun = { id: 77, attempt: 1, name: 'Agent / E2E Failure Analysis',
      path: '.github/workflows/agent-e2e-failure-analysis.yml', event: 'workflow_dispatch',
      head_branch: 'main', repository: { full_name: 'BestNathan/nession' },
      conclusion: 'success', display_title: 'E2E Failure Analysis ' + fingerprint.slice(5) + ':1',
      html_url: 'https://github.com/BestNathan/nession/actions/runs/77' };
    const created = plan({ store: root, fingerprint, analysisRun, diagnosis, issues: [] });
    assert.equal(created.action, 'CREATE');
    assert.ok(created.draft.body.includes('fingerprint: ' + fingerprint));
    const marker = '<!-- nession-e2e-failure-fingerprint: ' + fingerprint + ' -->';
    const commented = plan({ store: root, fingerprint, analysisRun, diagnosis,
      issues: [{ number: 9, state: 'open', body: marker }] });
    assert.equal(commented.action, 'COMMENT');
    assert.equal(commented.issue_number, 9);
    assert.match(commented.comment, /no additional analysis Agent was invoked/);
    const reopened = plan({ store: root, fingerprint, analysisRun, diagnosis,
      issues: [{ number: 9, state: 'closed', body: marker }] });
    assert.equal(reopened.action, 'REOPEN');
    // A diagnosis from a different claimed run is rejected before any draft.
    assert.throws(() => plan({ store: root, fingerprint,
      analysisRun: { ...analysisRun, id: 78 }, diagnosis, issues: [] }), /not the committed dispatch/);
    const linked = record({ store: root, fingerprint, analysisId: created.analysis_id, bugIssue: 9 });
    assert.equal(linked.action, 'LINKED');
    const admission = readFailureAdmission(root, fingerprint);
    assert.equal(admission.state.status, 'issue_linked');
    assert.equal(admission.state.bug_issue, 9);
    assert.throws(() => plan({ store: root, fingerprint, analysisRun, diagnosis, issues: [] }),
      /not awaiting a diagnosis/);
    assert.throws(() => record({ store: root, fingerprint, analysisId: created.analysis_id, bugIssue: 10 }),
      /not awaiting a diagnosis/);
    console.log('e2e failure analysis publish CLI self-test: passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'plan') {
    const [store, fingerprint, analysisRunFile, diagnosisFile, issuesFile, out] = args;
    if (!store || !fingerprint || !analysisRunFile || !diagnosisFile || !issuesFile || !out) {
      fail('usage: plan STORE FINGERPRINT ANALYSIS_RUN_JSON DIAGNOSIS_JSON ISSUES_JSON OUT');
    }
    const result = plan({
      store, fingerprint,
      analysisRun: JSON.parse(fs.readFileSync(analysisRunFile, 'utf8')),
      diagnosis: JSON.parse(fs.readFileSync(diagnosisFile, 'utf8')),
      issues: JSON.parse(fs.readFileSync(issuesFile, 'utf8')),
    });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (command === 'record') {
    const [store, fingerprint, analysisId, bugIssue] = args;
    if (!store || !fingerprint || !analysisId) fail('usage: record STORE FINGERPRINT ANALYSIS_ID BUG_ISSUE');
    process.stdout.write(JSON.stringify(record({
      store, fingerprint, analysisId, bugIssue: Number(bugIssue),
    })) + '\n');
    return;
  }
  fail('usage: self-test | plan STORE FINGERPRINT ANALYSIS_RUN_JSON DIAGNOSIS_JSON ISSUES_JSON OUT | record STORE FINGERPRINT ANALYSIS_ID BUG_ISSUE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error('e2e-failure-analysis-publish: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
