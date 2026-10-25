// #2327: canonical E2E Failure Analysis task contract. Owns the bounded model
// view, the Prompt selection and the diagnosis schema. It never performs a
// provider call, GitHub/Issue write, Store write, dispatch or verdict.
import { renderAgentPrompt } from '../prompt/index.mjs';
import { parseModelJson } from './model-json.mjs';

export const E2E_FAILURE_ANALYSIS_PROMPT_VERSION = 'v1';
const CATEGORIES = new Set(['product_regression', 'test_flake', 'environment_or_setup',
  'infrastructure_timeout', 'harness_or_reporting', 'unknown']);
const EVIDENCE_TYPES = new Set(['log', 'artifact', 'commit', 'file', 'run']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^e2e1:[a-f0-9]{64}$/;
const ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/;
const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const MAX_TEST_IDS = 64, MAX_EVIDENCE = 8, MAX_LOCATIONS = 8, MAX_STEPS = 10;
const MAX_UNKNOWNS = 10, MAX_ISSUES = 10, MAX_LINE = 600, MAX_SUMMARY = 2000;

function fail(message) { throw new Error('E2E failure analysis task: ' + message); }
function only(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    Object.keys(value).every((key) => fields.includes(key));
}
function singleLine(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) {
    fail('invalid ' + label);
  }
  return value;
}
function nullableLine(value, label, max) {
  return value == null ? null : singleLine(value, label, max);
}
function safePath(value, label) {
  if (typeof value !== 'string' || !value || value.length > 400 ||
      value.startsWith('/') || value.startsWith('\\') || value.includes('..') ||
      value.includes('\\') || /[\r\n]/.test(value)) fail('invalid ' + label);
  return value;
}
function boundedList(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail('invalid ' + label);
  return value;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }

// Host-owned facts only: identity comes from an authenticated observation, and
// evidence excerpts are already bounded and redacted by the trusted collector.
export function e2eFailureAnalysisFacts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('facts must be an object');
  const source = input.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      source.repository !== 'BestNathan/nession' ||
      source.workflow_name !== 'E2E / Full Regression' ||
      !positive(source.run_id) || !positive(source.run_attempt) ||
      !SHA.test(source.target_sha ?? '') ||
      !ENVIRONMENT.test(source.environment_id ?? '') ||
      !Number.isFinite(Date.parse(source.completed_at ?? ''))) {
    fail('invalid authenticated source identity');
  }
  if (!FINGERPRINT.test(input.fingerprint ?? '')) fail('invalid failure fingerprint');
  const failedTests = boundedList(input.failed_tests, 'failed tests', MAX_TEST_IDS).map((item) => {
    if (!only(item, ['id', 'kind']) || !TEST_ID.test(item.id ?? '')) fail('invalid failed test');
    return Object.freeze({ id: item.id, kind: singleLine(item.kind, 'failure kind', 40) });
  });
  if (!failedTests.length) fail('failed tests are required');
  const evidence = boundedList(input.evidence ?? [], 'evidence', 20).map((item) => {
    if (!only(item, ['type', 'ref', 'excerpt']) || !EVIDENCE_TYPES.has(item.type)) {
      fail('invalid evidence item');
    }
    return Object.freeze({
      type: item.type,
      ref: singleLine(item.ref, 'evidence reference', 300),
      excerpt: singleLine(item.excerpt, 'evidence excerpt', 4000),
    });
  });
  const candidateIssues = boundedList(input.candidate_issues ?? [], 'candidate issues', MAX_ISSUES).map((item) => {
    if (!only(item, ['number', 'title', 'state']) || !positive(item.number) ||
        !['open', 'closed'].includes(item.state)) fail('invalid candidate Issue');
    return Object.freeze({ number: item.number, title: singleLine(item.title, 'candidate title', 300),
      state: item.state });
  });
  return Object.freeze({
    source: Object.freeze({
      repository: source.repository,
      workflow_name: source.workflow_name,
      run_id: source.run_id,
      run_attempt: source.run_attempt,
      target_sha: source.target_sha,
      environment_id: source.environment_id,
      completed_at: source.completed_at,
    }),
    fingerprint: input.fingerprint,
    failed_tests: Object.freeze(failedTests),
    evidence: Object.freeze(evidence),
    candidate_issues: Object.freeze(candidateIssues),
  });
}

export function e2eFailureAnalysisModelView(input) {
  const facts = e2eFailureAnalysisFacts(input);
  return Object.freeze({
    source: facts.source,
    fingerprint: facts.fingerprint,
    failed_tests: facts.failed_tests,
    evidence: facts.evidence,
    candidate_issues: facts.candidate_issues,
  });
}

export function renderE2eFailureAnalysisPrompt(input) {
  const view = e2eFailureAnalysisModelView(input);
  return renderAgentPrompt({
    id: 'e2e-failure-analysis',
    version: E2E_FAILURE_ANALYSIS_PROMPT_VERSION,
    context: { contextJson: JSON.stringify(view, null, 2) },
  });
}

// Validate the model diagnosis against the bounded schema and bind it to the
// host identity. A model cannot select another run/SHA/environment, claim a
// verified cause, or cite Issues that were not supplied as candidates.
export function e2eFailureAnalysisResult(input, raw) {
  const facts = e2eFailureAnalysisFacts(input);
  const parsed = parseModelJson(raw, 'E2E Failure Analysis Agent');
  const fields = ['failure_category', 'failed_test_ids', 'expected', 'actual', 'evidence',
    'suspected_locations', 'causal_hypothesis', 'reproducible_steps',
    'proposed_regression_test', 'candidate_issues', 'unknowns'];
  if (!only(parsed, fields)) fail('unexpected diagnosis fields');
  if (!CATEGORIES.has(parsed.failure_category)) fail('invalid failure category');
  const knownIds = new Set(facts.failed_tests.map((item) => item.id));
  const failedTestIds = boundedList(parsed.failed_test_ids, 'failed_test_ids', MAX_TEST_IDS)
    .map((id) => {
      if (!TEST_ID.test(id ?? '') || !knownIds.has(id)) fail('failed test ID is not in the supplied context');
      return id;
    });
  if (new Set(failedTestIds).size !== failedTestIds.length) fail('duplicate failed test ID');
  const evidence = boundedList(parsed.evidence, 'evidence', MAX_EVIDENCE).map((item) => {
    if (!only(item, ['type', 'ref', 'note']) || !EVIDENCE_TYPES.has(item.type)) fail('invalid diagnosis evidence');
    return Object.freeze({ type: item.type, ref: singleLine(item.ref, 'evidence ref', MAX_LINE),
      note: singleLine(item.note, 'evidence note', MAX_LINE) });
  });
  const suspectedLocations = boundedList(parsed.suspected_locations, 'suspected_locations', MAX_LOCATIONS)
    .map((item) => {
      if (!only(item, ['path', 'line', 'reason'])) fail('invalid suspected location');
      if (item.line != null && !positive(item.line)) fail('invalid suspected location line');
      return Object.freeze({ path: safePath(item.path, 'suspected location path'),
        line: item.line ?? null, reason: singleLine(item.reason, 'location reason', MAX_LINE) });
    });
  const hypothesis = parsed.causal_hypothesis;
  if (!only(hypothesis, ['summary', 'confidence', 'status']) ||
      hypothesis.status !== 'hypothesis' || !CONFIDENCE.has(hypothesis.confidence)) {
    fail('causal hypothesis must be explicitly labeled with a confidence');
  }
  const reproducibleSteps = boundedList(parsed.reproducible_steps, 'reproducible_steps', MAX_STEPS)
    .map((step) => singleLine(step, 'reproducible step', MAX_LINE));
  let proposedTest = null;
  if (parsed.proposed_regression_test != null) {
    if (!only(parsed.proposed_regression_test, ['path', 'assertion'])) fail('invalid proposed regression test');
    proposedTest = Object.freeze({
      path: safePath(parsed.proposed_regression_test.path, 'proposed test path'),
      assertion: singleLine(parsed.proposed_regression_test.assertion, 'proposed assertion', MAX_LINE),
    });
  }
  const knownIssues = new Set(facts.candidate_issues.map((issue) => issue.number));
  const candidateIssues = boundedList(parsed.candidate_issues, 'candidate_issues', MAX_ISSUES).map((number) => {
    if (!positive(number) || !knownIssues.has(number)) fail('candidate Issue was not supplied in the context');
    return number;
  });
  const unknowns = boundedList(parsed.unknowns, 'unknowns', MAX_UNKNOWNS)
    .map((item) => singleLine(item, 'unknown', MAX_LINE));
  // A product-regression claim needs at least one verifiable pointer; a
  // category of "unknown" must say what is missing instead of guessing.
  if (parsed.failure_category === 'product_regression' && evidence.length === 0 && suspectedLocations.length === 0) {
    fail('product regression requires evidence or a suspected location');
  }
  if (parsed.failure_category === 'unknown' && unknowns.length === 0) {
    fail('unknown category requires at least one explicit unknown');
  }
  return Object.freeze({
    kind: 'e2e_failure_diagnosis',
    repository: facts.source.repository,
    source_run_id: facts.source.run_id,
    source_run_attempt: facts.source.run_attempt,
    target_sha: facts.source.target_sha,
    environment_id: facts.source.environment_id,
    fingerprint: facts.fingerprint,
    failure_category: parsed.failure_category,
    failed_test_ids: Object.freeze(failedTestIds),
    expected: nullableLine(parsed.expected, 'expected result', MAX_LINE),
    actual: nullableLine(parsed.actual, 'actual result', MAX_LINE),
    evidence: Object.freeze(evidence),
    suspected_locations: Object.freeze(suspectedLocations),
    causal_hypothesis: Object.freeze({
      summary: singleLine(hypothesis.summary, 'hypothesis summary', MAX_SUMMARY),
      confidence: hypothesis.confidence,
      status: 'hypothesis',
    }),
    reproducible_steps: Object.freeze(reproducibleSteps),
    proposed_regression_test: proposedTest,
    candidate_issues: Object.freeze(candidateIssues),
    unknowns: Object.freeze(unknowns),
  });
}
