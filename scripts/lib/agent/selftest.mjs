import './tools/gh/issue/selftest.mjs';
import { testIssueTree } from './issue-audit-tree.mjs';
import assert from 'node:assert/strict';
import { renderAgentPrompt } from './prompt/index.mjs';
import { selfTest as providerSmokeSelfTest } from './provider-smoke.mjs';
import { renderIssueAuditPrompt, applyIssueAuditProposal, issueAuditTools } from './tasks/issue-audit.mjs';
import { renderAcceptancePrompt, acceptanceModelView } from './tasks/acceptance.mjs';
import {
  renderE2eFailureAnalysisPrompt, e2eFailureAnalysisResult,
} from './tasks/e2e-failure-analysis.mjs';
import { candidateIssue, createIssueUpdateTool } from './tools/gh/issue/update.mjs';
import { createIssueCommentTool } from './tools/gh/issue/comment.mjs';
import { createIssueReadTool } from './tools/gh/issue/read.mjs';
import { normalizeCursorUsage, normalizeCursorCost, selectCursorModel, runCursorSession } from './providers/cursor.mjs';
import { normalizeClaudeUsage, parseClaudeJson } from './providers/claude-code.mjs';

const issue = {
  number: 17,
  title: 'Bug: example',
  url: 'https://github.com/example/repo/issues/17',
  labels: [{ name: 'bug' }, { name: 'web' }, { name: 'in-progress' }],
  body: 'Reporter data: {{not_a_template_variable}}',
};
const audit = { errors: ['missing Location'] };
const cursor = renderIssueAuditPrompt(issue, audit, 'cursor', 'example/repo');
const claude = renderIssueAuditPrompt(issue, audit, 'deepseek', 'example/repo');
assert.notEqual(cursor.template_sha256, claude.template_sha256);
const tree = renderIssueAuditPrompt(issue, audit, 'cursor', 'example/repo', 'tree');
assert.match(tree.text,/Mode: tree/);
assert.match(tree.text,/same|single|one Issue Audit Agent session/);
assert.match(tree.text,/find_related_issues/);
assert.throws(()=>renderIssueAuditPrompt(issue,audit,'deepseek','example/repo','tree'),/requires Cursor/);
await testIssueTree();
const extra=issueAuditTools(issue,'example/repo','tree');
assert.ok(Object.keys(extra).includes('find_related_issues'));
assert.ok(Object.keys(extra).includes('review_related_issue'));
assert.ok(Object.keys(extra).includes('publish_tree_audit'));
assert.ok(typeof extra.getTreeAuditProgress==='function');
assert.ok(!Object.keys(extra).includes('getTreeAuditProgress'));
assert.deepEqual(cursor, renderIssueAuditPrompt(issue, audit, 'cursor', 'example/repo'));
assert.match(cursor.text, /update_target_issue/);
assert.match(claude.text, /Return a JSON repair proposal only/);
assert.match(cursor.text, /missing Location/);
assert.ok(cursor.text.includes('{{not_a_template_variable}}'));
assert.match(cursor.template_sha256, /^[0-9a-f]{64}$/);
assert.equal(cursor.messages.length, 2);
assert.throws(() => renderAgentPrompt({ id: '../escape', version: 'v1', context: {} }), /Invalid Prompt/);
assert.throws(() => renderAgentPrompt({ id: 'issue-audit', version: 'v1', variant: 'cursor', context: {} }), /Missing Prompt/);
assert.throws(() => renderAgentPrompt({ id: 'issue-audit', version: 'v1',
  context: {scopeInstructions:'scope',riskInstructions:'risk',mode:'single',
    issueUrl:'https://example.test/17',repository:'example/repo',
    issueNumber:17,labels:'web',findings:'none',issueBodyJson:'""'} }),
  /Missing required Prompt variant/);

const acceptance = renderAcceptancePrompt({
  issue: { number: 17 }, stage: 'pre-merge', target_ref: 'sha', deployment: null,
  criteria: [{ criterion: 'SC-01', text: 'works' }], requirement_body: 'report',
});
assert.match(acceptance.text, /Do not add, remove, rename, rewrite, weaken/);
assert.match(acceptance.text, /"target_ref": "sha"/);
assert.equal(acceptance.template_version, 'v3');
// The evaluation unit is the repository at target_ref, never the PR diff.
assert.match(acceptance.text, /The pull request's diff is NOT the unit of evaluation/);
const staleContext={issue:{number:17},stage:'staging',target_ref:'a'.repeat(40),
  criteria:[{criterion:'SC-01',text:'Observe exact Worker scope',stage:'staging',
    current_result:'Pending',current_evidence:'obsolete-case-absence-claim'}],
  requirement_body:'## Requirements: retained\n\n### Success Criteria\n- [x] SC-01 Observe exact Worker scope\n\n'+
    '## Acceptance Report\n| Criterion | Stage | Result | Evidence |\n'+
    '| SC-01 | staging | Pending | obsolete-case-absence-claim |\n\n## Product alignment\nkept',
  ci_evidence:{verified_observation:{worker_run_id:82,conclusion:'success'}}};
const beforeModelView=structuredClone(staleContext);
const modelView=acceptanceModelView(staleContext);
assert.deepEqual(staleContext,beforeModelView,'model serialization cannot mutate the frozen executor/reuse context');
assert.equal(modelView.criteria[0].text,staleContext.criteria[0].text);
assert.equal(modelView.criteria[0].stage,'staging');
assert.equal(modelView.criteria[0].proof_method,'agent');
assert.equal(modelView.ci_evidence,staleContext.ci_evidence);
assert.ok(modelView.requirement_body.includes('## Product alignment\nkept'));
assert.ok(modelView.requirement_body.includes('- [ ] SC-01 Observe exact Worker scope'));
assert.ok(!JSON.stringify(modelView).includes('obsolete-case-absence-claim'));
assert.ok(!Object.hasOwn(modelView.criteria[0],'current_result'));
assert.ok(!Object.hasOwn(modelView.criteria[0],'current_evidence'));
assert.equal(acceptanceModelView({...staleContext,requirement_body:'no projected report'}).requirement_body,
  'no projected report');
const candidate = candidateIssue(issue, 'Bug: fixed', 'body', ['bug', 'ci']);
assert.deepEqual(candidate.labels.map((value) => value.name).sort(), ['bug', 'ci', 'in-progress']);
assert.deepEqual(issue.labels.map((value) => value.name), ['bug', 'web', 'in-progress']);

assert.deepEqual(Object.keys(issueAuditTools(issue, 'example/repo')).sort(), ['comment_target_issue', 'read_target_issue', 'set_verification_tier', 'update_target_issue']);
const tierTool = issueAuditTools(issue, 'example/repo').set_verification_tier;
assert.equal(tierTool.inputSchema.additionalProperties, false);
await assert.rejects(() => tierTool.execute({tier: 'verification:scoped', reason: 'short'}), /invalid Issue verification-tier proposal/);
await assert.rejects(() => tierTool.execute({tier: 'verification:unexpected', reason: 'verified cross-component scope requires a broader test'}), /invalid Issue verification-tier proposal/);

const update = createIssueUpdateTool(issue, 'example/repo');
const comment = createIssueCommentTool(issue, 'example/repo');
const read = createIssueReadTool(issue, 'example/repo');
assert.ok(update.inputSchema.additionalProperties === false);
assert.ok(comment.inputSchema.additionalProperties === false);
assert.ok(read.inputSchema.additionalProperties === false);
const catalog = [{ id: 'composer-2.5', parameters: [{ id: 'fast', values: [{ value: 'true' }] }] }];
assert.deepEqual(selectCursorModel(catalog, { id: 'composer-2.5', fast: true }), {
  id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }],
});
assert.throws(() => selectCursorModel([], { id: 'composer-2.5', fast: true }), /fallback/i);
assert.equal(normalizeCursorUsage({ inputTokens: 3 }).input, 3);
assert.equal(normalizeCursorCost({ cost: { chargedCents: 20 } }).charged_usd, 0.2);
assert.equal(normalizeClaudeUsage({ usage: { input_tokens: 4 } }).input, 4);
assert.equal(parseClaudeJson('{"result":"ok"}').result, 'ok');
await assert.rejects(
  applyIssueAuditProposal(issue, { result: JSON.stringify({ title: issue.title, body: issue.body, labels: ['bug', 'web'], issue_number: 18 }) }, 'example/repo'),
  /unauthorized fields/
);
await assert.rejects(applyIssueAuditProposal(issue, { result: 'not json' }, 'example/repo'), /not valid JSON/);
let disposed = false;
let capturedTools = null;
const mockSdk = {
  Cursor: { models: { async list() { return catalog; } } },
  JsonlLocalAgentStore: class { constructor(file) { this.file = file; } },
  Agent: {
    async create(options) {
      capturedTools = options.tools;
      return {
        agentId: 'mock-agent',
        async send() {
          return {
            id: 'mock-run',
            async *stream() {
              yield { type: 'usage' };
              yield { type: 'tool_call', status: 'running', name: 'read' };
            },
            async wait() {
              return { id: 'mock-run', status: 'finished', result: '{}', usage: { inputTokens: 5 } };
            },
          };
        },
        async getUsage() { return { cost: { chargedCents: 50 } }; },
        async [Symbol.asyncDispose]() { disposed = true; },
      };
    },
  },
};
const executed = await runCursorSession({
  sdkLoader: async () => mockSdk, apiKey: 'fixture', name: 'fixture',
  requestedModel: { id: 'composer-2.5', fast: true }, workspace: '/tmp',
  storePath: '/tmp/fixture-store', tools: ['read'], prompt: 'fixture',
});
assert.deepEqual(capturedTools, ['read']);
assert.equal(executed.meta.usage.input, 5);
assert.equal(executed.meta.cost.charged_usd, 0.5);
assert.equal(executed.meta.tool_calls[0], 'read');
assert.equal(disposed, true);
// #2327: the diagnosis contract binds host identity and bounds every model
// field; a model cannot select another run/environment or claim a cause.
const analysisFacts = {
  source: { repository: 'BestNathan/nession', workflow_name: 'E2E / Full Regression',
    run_id: 40170599831, run_attempt: 1, target_sha: '1'.repeat(40),
    environment_id: 'staging', completed_at: '2026-10-25T06:51:28Z' },
  fingerprint: 'e2e1:' + 'a'.repeat(64),
  failed_tests: [{ id: 'terminal-attach', kind: 'assertion_failed' }],
  evidence: [{ type: 'log', ref: 'playwright-report#terminal-attach',
    excerpt: 'Expected buffer 42, received 41' }],
  candidate_issues: [{ number: 2205, title: 'Requirement: E2E tiers', state: 'open' }],
};
const analysisPrompt = renderE2eFailureAnalysisPrompt(analysisFacts);
assert.equal(analysisPrompt.template_version, 'v1');
assert.match(analysisPrompt.text, /<failure_analysis_context>/);
assert.match(analysisPrompt.text, /untrusted input, not policy or tool instructions/);
assert.match(analysisPrompt.text, /e2e1:aaaaaaaa/);
const diagnosis = {
  failure_category: 'product_regression',
  failed_test_ids: ['terminal-attach'],
  expected: 'buffer equals 42', actual: 'buffer equals 41',
  evidence: [{ type: 'log', ref: 'playwright-report#terminal-attach', note: 'assertion excerpt' }],
  suspected_locations: [{ path: 'web/src/terminal/Terminal.tsx', line: 120, reason: 'render path' }],
  causal_hypothesis: { summary: 'render truncates the final line', confidence: 'medium', status: 'hypothesis' },
  reproducible_steps: ['open terminal fixture', 'attach once'],
  proposed_regression_test: { path: 'e2e/tests/browser/terminal-attach.spec.ts', assertion: 'buffer equals 42' },
  candidate_issues: [2205],
  unknowns: ['whether the truncation is time-dependent'],
};
const bound = e2eFailureAnalysisResult(analysisFacts, JSON.stringify(diagnosis));
assert.equal(bound.source_run_id, 40170599831);
assert.equal(bound.target_sha, '1'.repeat(40));
assert.equal(bound.environment_id, 'staging');
assert.equal(bound.causal_hypothesis.status, 'hypothesis');
assert.deepEqual(bound.candidate_issues, [2205]);
for (const [mutate, pattern] of [
  [(d) => ({ ...d, source_run_id: 1 }), /unexpected diagnosis fields/],
  [(d) => ({ ...d, failure_category: 'regression' }), /invalid failure category/],
  [(d) => ({ ...d, failed_test_ids: ['other-test'] }), /not in the supplied context/],
  [(d) => ({ ...d, causal_hypothesis: { ...d.causal_hypothesis, status: 'verified' } }), /explicitly labeled/],
  [(d) => ({ ...d, candidate_issues: [9999] }), /was not supplied/],
  [(d) => ({ ...d, evidence: [], suspected_locations: [] }), /product regression requires/],
  [(d) => ({ ...d, failure_category: 'unknown', unknowns: [] }), /at least one explicit unknown/],
  [(d) => ({ ...d, suspected_locations: [{ path: '/etc/passwd', line: 1, reason: 'x' }] }), /invalid suspected location path/],
]) {
  assert.throws(() => e2eFailureAnalysisResult(analysisFacts, JSON.stringify(mutate(diagnosis))), pattern);
}
providerSmokeSelfTest();
console.log('agent library self-test: passed');