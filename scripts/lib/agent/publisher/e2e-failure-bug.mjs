#!/usr/bin/env node
// #2327: deterministic Bug publication contract for an authenticated E2E
// failure diagnosis. This module owns the diagnosis re-validation, the hidden
// fingerprint identity, the Bug/comment draft and the Issue-contract check. It
// performs no GitHub call, Store write or model call; the trusted publisher
// workflow creates/updates the Issue and records the ledger link.
import assert from 'node:assert/strict';
import { auditIssue } from '../../../issue-contract.mjs';
import { e2eFailureAnalysisResult } from '../tasks/e2e-failure-analysis.mjs';

const REPO = 'BestNathan/nession';
const ANALYSIS_NAME = 'Agent / E2E Failure Analysis';
const ANALYSIS_PATH = '.github/workflows/agent-e2e-failure-analysis.yml';
const TITLE_PREFIX = 'E2E Failure Analysis ';
const ANALYSIS_ID = /^([a-f0-9]{64}):([1-9][0-9]*)$/;
const AREA_BY_PREFIX = [
  ['web/', 'web'], ['e2e/', 'test'], ['scripts/', 'ci'], ['docs/', 'documentation'],
  ['crates/nession-agent/', 'agent'], ['crates/nession-server/', 'server'],
  ['crates/nession-protocol/', 'protocol'], ['crates/nession-cli/', 'cli'],
];

function fail(message) { throw new Error('e2e failure bug publisher: ' + message); }
function digestOf(fingerprint) {
  if (typeof fingerprint !== 'string' || !/^e2e1:[a-f0-9]{64}$/.test(fingerprint)) fail('invalid fingerprint');
  return fingerprint.slice(5);
}

export function fingerprintLabel(fingerprint) {
  return 'e2e-fp-' + digestOf(fingerprint).slice(0, 16);
}

export function fingerprintMarker(fingerprint) {
  return '<!-- nession-e2e-failure-fingerprint: ' + fingerprint + ' -->';
}

export function analysisMarker(analysisId) {
  if (!ANALYSIS_ID.test(analysisId)) fail('invalid analysis id');
  return '<!-- nession-e2e-failure-analysis: ' + analysisId + ' -->';
}

// Re-run the canonical bounded schema against the trusted request and require
// the stored diagnosis to be byte-identical after re-validation. The Agent run
// must be the authenticated main dispatch that carries the same analysis id.
export function validateDiagnosisForPublication({ diagnosis, request, analysisRun }) {
  if (!diagnosis || diagnosis.kind !== 'e2e_failure_diagnosis') fail('not a stored diagnosis record');
  const model = {
    failure_category: diagnosis.failure_category,
    failed_test_ids: [...diagnosis.failed_test_ids],
    expected: diagnosis.expected,
    actual: diagnosis.actual,
    evidence: diagnosis.evidence.map((item) => ({ type: item.type, ref: item.ref, note: item.note })),
    suspected_locations: diagnosis.suspected_locations.map((item) => ({
      path: item.path, line: item.line, reason: item.reason })),
    causal_hypothesis: { ...diagnosis.causal_hypothesis },
    reproducible_steps: [...diagnosis.reproducible_steps],
    proposed_regression_test: diagnosis.proposed_regression_test
      ? { ...diagnosis.proposed_regression_test } : null,
    candidate_issues: [...diagnosis.candidate_issues],
    unknowns: [...diagnosis.unknowns],
  };
  const revalidated = e2eFailureAnalysisResult(request, JSON.stringify(model));
  assert.deepEqual(JSON.parse(JSON.stringify(revalidated)), JSON.parse(JSON.stringify(diagnosis)));

  const run = analysisRun;
  if (!run || run.name !== ANALYSIS_NAME || run.path !== ANALYSIS_PATH ||
      run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
      run.repository?.full_name !== REPO || run.conclusion !== 'success' ||
      !Number.isSafeInteger(run.id) || run.id < 1 ||
      !Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    fail('analysis run is not an authenticated completed main dispatch');
  }
  const title = String(run.display_title ?? '');
  if (!title.startsWith(TITLE_PREFIX)) fail('analysis run does not carry an analysis id');
  const id = title.slice(TITLE_PREFIX.length).trim();
  const match = ANALYSIS_ID.exec(id);
  if (!match || match[1] !== digestOf(diagnosis.fingerprint)) {
    fail('analysis run id does not bind the diagnosis fingerprint');
  }
  return Object.freeze({ analysis_id: id, epoch: Number(match[2]), diagnosis, request,
    analysis_run: { id: run.id, attempt: run.attempt, url: run.html_url ?? null } });
}

function areaOf(diagnosis) {
  for (const location of diagnosis.suspected_locations) {
    const prefix = AREA_BY_PREFIX.find(([start]) => location.path.startsWith(start));
    if (prefix) return prefix[1];
  }
  return 'ci';
}

function impactOf(diagnosis) {
  switch (diagnosis.failure_category) {
    case 'product_regression':
      return 'An authenticated E2E failure blocks the applicable release gate until a verified fix is accepted. Unrelated Issues and other failures are not blocked.';
    case 'environment_or_setup':
      return 'Classified as environment/CI setup impact; it is tracked as tooling impact and does not assert a product defect.';
    case 'infrastructure_timeout':
      return 'Classified as infrastructure timeout impact; it is tracked as tooling impact and does not assert a product defect.';
    case 'harness_or_reporting':
      return 'Classified as harness/reporting impact; the failure evidence itself is preserved and no product defect is asserted.';
    case 'test_flake':
      return 'Classified as a flaky test; repeated occurrences cost signal quality, while any real regression still blocks the applicable release gate.';
    default:
      return 'The failure is repeatable but could not be classified; investigation is required before any product-defect claim.';
  }
}

export function bugDraft({ bound }) {
  const { diagnosis, request, analysis_run: run, analysis_id: analysisId } = bound;
  const testIds = diagnosis.failed_test_ids;
  const category = diagnosis.failure_category.replaceAll('_', ' ');
  const title = 'Bug: E2E ' + testIds.slice(0, 3).join(', ') + ' failed (' + category + ')';
  const steps = diagnosis.reproducible_steps.length
    ? diagnosis.reproducible_steps.map((step) => '- ' + step).join('\n')
    : '- No deterministic local steps: rely on the authenticated run evidence below.';
  const locations = diagnosis.suspected_locations.length
    ? diagnosis.suspected_locations.map((item) =>
      '- `' + item.path + (item.line ? ':' + item.line : '') + '` — ' + item.reason).join('\n')
    : '- Not localized by the available evidence.';
  const unknowns = diagnosis.unknowns.length
    ? diagnosis.unknowns.map((item) => '- ' + item).join('\n')
    : '- None recorded.';
  const regression = diagnosis.proposed_regression_test
    ? '- Add or adjust `' + diagnosis.proposed_regression_test.path + '` asserting: ' +
      diagnosis.proposed_regression_test.assertion
    : '- No narrow regression test was proposed; triage the evidence first.';
  const e2eIds = testIds.filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id));
  const e2eRegression = e2eIds.length
    ? e2eIds.map((id) => '- ' + id).join('\n')
    : '- none: the failing test id is not a browser spec stem; the run evidence is authoritative.';
  const body = [
    fingerprintMarker(diagnosis.fingerprint),
    analysisMarker(analysisId),
    '',
    '## Description',
    '',
    'An authenticated E2E / Full Regression run failed for `' + testIds.join('`, `') + '`.',
    '',
    '- Source run: `' + request.source.run_id + '/' + request.source.run_attempt + '`',
    '- Target SHA: `' + request.source.target_sha + '`',
    '- Environment: `' + request.source.environment_id + '`',
    '- Failure category: `' + diagnosis.failure_category + '`',
    '- Fingerprint: `' + diagnosis.fingerprint + '` (epoch ' + bound.epoch + ')',
    '',
    '## Reproduction',
    '',
    steps,
    '',
    '## Investigation Status',
    '',
    'A read-only analysis Agent produced a bounded **hypothesis**, not a verified root cause.',
    '',
    '- Hypothesis (confidence `' + diagnosis.causal_hypothesis.confidence + '`): ' +
      diagnosis.causal_hypothesis.summary,
    '- Evidence:',
    ...(diagnosis.evidence.length
      ? diagnosis.evidence.map((item) => '  - `' + item.type + '` `' + item.ref + '` — ' + item.note)
      : ['  - The authenticated run and its failure signatures (no model-readable logs were supplied).']),
    '- Unknowns:',
    ...unknowns.split('\n').map((line) => (line.startsWith('- ') ? '  ' + line : line)),
    '',
    '## Impact',
    '',
    impactOf(diagnosis),
    '',
    '## Fix Direction',
    '',
    regression,
    '',
    'After a fix, replay the selected E2E at the fixed SHA and link the passing receipt here; a closed Bug may only be closed through trusted acceptance.',
    '',
    '## Location',
    '',
    locations,
    '',
    '## Evidence',
    '',
    '- Failed Full Regression run: `' + request.source.run_id + '/' + request.source.run_attempt + '`',
    '- Analysis run: `' + run.id + '/' + run.attempt + '`' + (run.url ? ' (' + run.url + ')' : ''),
    '- Analysis id: `' + analysisId + '`',
    '',
    '### Success Criteria',
    '',
    '- [ ] SC-01 The failing behavior in `' + testIds.join('`, `') +
      '` is restored at the fixing SHA, proven by the selected E2E replay and trusted acceptance.',
    '',
    '## Acceptance Plan',
    '',
    '```yaml',
    'acceptance:',
    '  SC-01:',
    '    when: pr',
    '    method: agent',
    '```',
    '',
    '## Acceptance Report',
    '',
    '| Criterion | Result | Evidence |',
    '| --- | --- | --- |',
    '| SC-01 | Pending | awaiting the fixing SHA and selected E2E replay |',
    '',
    '## E2E Verification',
    '',
    '### New',
    '- none: this Bug records an existing failing test, not a new browser behavior.',
    '',
    '### Regression',
    e2eRegression,
    '',
    '## E2E Report',
    '',
    '| ID | Type | Result | Evidence |',
    '| --- | --- | --- | --- |',
    ...(e2eIds.length
      ? e2eIds.map((id) => '| ' + id + ' | Regression | Pending | - |')
      : []),
    '',
    '## Product alignment',
    '',
    '- [x] Does this move Nession toward VISION.md? Yes: trustworthy failure evidence keeps parallel delivery safe.',
    '- [x] Does it obey PRINCIPLE.md? Yes: the suspected cause is a labeled hypothesis, never a fabricated verdict.',
    '- [x] Were relevant docs/design/* sources checked? No UI/design change is asserted.',
    '- [x] Is any deviation explicit? None.',
    '',
    '---',
    '**Status:** Approved',
  ].join('\n');
  const issue = {
    title, body,
    labels: ['bug', areaOf(diagnosis), fingerprintLabel(diagnosis.fingerprint), 'verification:scoped'],
    createdAt: new Date().toISOString(),
  };
  const audit = auditIssue(issue);
  if (!audit.ok) fail('published Bug draft fails the issue contract: ' + audit.errors.join('; '));
  return issue;
}

// Only the hidden, publisher-written marker identifies a Bug. A matching title
// or Issue prose is not proof (one root cause may surface in several tests).
export function findExistingBug({ issues, fingerprint }) {
  if (!Array.isArray(issues)) fail('issues must be an array');
  const marker = fingerprintMarker(fingerprint);
  return issues.find((issue) => typeof issue?.body === 'string' && issue.body.includes(marker)) ?? null;
}

export function recurrenceComment({ bound }) {
  const { diagnosis, request, analysis_run: run, analysis_id: analysisId } = bound;
  return [
    analysisMarker(analysisId),
    '',
    '## Recurrence evidence',
    '',
    '- Source run: `' + request.source.run_id + '/' + request.source.run_attempt + '`',
    '- Target SHA: `' + request.source.target_sha + '`',
    '- Environment: `' + request.source.environment_id + '`',
    '- Analysis run: `' + run.id + '/' + run.attempt + '`' + (run.url ? ' (' + run.url + ')' : ''),
    '- Fingerprint epoch: ' + bound.epoch + ' (`' + diagnosis.fingerprint + '`)',
    '',
    'This observation was attached to the existing Bug; no additional analysis Agent was invoked for the same unresolved fingerprint.',
  ].join('\n');
}

function selfTest() {
  const request = {
    source: { repository: REPO, workflow_name: 'E2E / Full Regression',
      run_id: 40170599831, run_attempt: 1, target_sha: '1'.repeat(40),
      environment_id: 'main', completed_at: '2026-10-25T06:51:28Z' },
    fingerprint: 'e2e1:' + 'a'.repeat(64),
    failed_tests: [{ id: 'terminal-attach', kind: 'assertion_failed' }],
    evidence: [{ type: 'log', ref: 'signature:terminal-attach',
      excerpt: 'kind=assertion_failed; frame=web/src/terminal/Terminal.spec.ts:42' }],
    candidate_issues: [],
  };
  const diagnosis = e2eFailureAnalysisResult(request, JSON.stringify({
    failure_category: 'product_regression',
    failed_test_ids: ['terminal-attach'],
    expected: 'buffer equals 42', actual: 'buffer equals 41',
    evidence: [{ type: 'log', ref: 'signature:terminal-attach', note: 'assertion signature' }],
    suspected_locations: [{ path: 'web/src/terminal/Terminal.tsx', line: 120, reason: 'render path' }],
    causal_hypothesis: { summary: 'render truncates the final line', confidence: 'medium', status: 'hypothesis' },
    reproducible_steps: ['attach once'],
    proposed_regression_test: { path: 'e2e/tests/browser/terminal-attach.spec.ts', assertion: 'buffer equals 42' },
    candidate_issues: [], unknowns: ['whether the truncation is time-dependent'],
  }));
  const analysisRun = { id: 77, attempt: 1, name: ANALYSIS_NAME, path: ANALYSIS_PATH,
    event: 'workflow_dispatch', head_branch: 'main',
    repository: { full_name: REPO }, conclusion: 'success',
    display_title: TITLE_PREFIX + 'a'.repeat(64) + ':1',
    html_url: 'https://github.com/BestNathan/nession/actions/runs/77' };
  const bound = validateDiagnosisForPublication({ diagnosis, request, analysisRun });
  assert.equal(bound.analysis_id, 'a'.repeat(64) + ':1');
  const draft = bugDraft({ bound });
  assert.equal(draft.labels.includes('bug'), true);
  assert.equal(draft.labels.includes('web'), true);
  assert.match(draft.body, /## Investigation Status/);
  assert.doesNotMatch(draft.body, /## Root Cause/);
  assert.match(draft.body, /read-only analysis Agent produced a bounded \*\*hypothesis\*\*/);
  assert.ok(auditIssue(draft).ok, 'draft must satisfy the Issue contract');

  // A tampered diagnosis, a foreign analysis run and a mismatched id all fail closed.
  assert.throws(() => validateDiagnosisForPublication({
    diagnosis: { ...diagnosis, failed_test_ids: ['other'] }, request, analysisRun,
  }), /not in the supplied context/);
  assert.throws(() => validateDiagnosisForPublication({
    diagnosis, request, analysisRun: { ...analysisRun, event: 'push' },
  }), /authenticated completed main dispatch/);
  assert.throws(() => validateDiagnosisForPublication({
    diagnosis, request,
    analysisRun: { ...analysisRun, display_title: TITLE_PREFIX + 'b'.repeat(64) + ':1' },
  }), /does not bind/);
  const marker = fingerprintMarker(diagnosis.fingerprint);
  const existing = { number: 9, state: 'open', body: 'unrelated\n' + marker };
  assert.equal(findExistingBug({ issues: [existing], fingerprint: diagnosis.fingerprint }).number, 9);
  assert.equal(findExistingBug({ issues: [{ number: 10, body: 'same title only' }],
    fingerprint: diagnosis.fingerprint }), null);
  const comment = recurrenceComment({ bound });
  assert.match(comment, /40170599831\/1/);
  assert.match(comment, /no additional analysis Agent was invoked/);
  console.log('e2e failure Bug publisher contract: draft, dedup and negative fixtures passed');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  if (process.argv[2] === 'self-test') selfTest();
  else throw new Error('usage: e2e-failure-bug.mjs self-test');
}
