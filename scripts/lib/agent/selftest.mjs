import './tools/gh/issue/selftest.mjs';
import assert from 'node:assert/strict';
import { renderAgentPrompt } from './prompt/index.mjs';
import { renderIssueAuditPrompt, applyIssueAuditProposal, issueAuditTools } from './tasks/issue-audit.mjs';
import { renderAcceptancePrompt } from './tasks/acceptance.mjs';
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
assert.deepEqual(cursor, renderIssueAuditPrompt(issue, audit, 'cursor', 'example/repo'));
assert.match(cursor.text, /update_target_issue/);
assert.match(claude.text, /Return a JSON repair proposal only/);
assert.match(cursor.text, /missing Location/);
assert.ok(cursor.text.includes('{{not_a_template_variable}}'));
assert.match(cursor.template_sha256, /^[0-9a-f]{64}$/);
assert.equal(cursor.messages.length, 2);
assert.throws(() => renderAgentPrompt({ id: '../escape', version: 'v1', context: {} }), /Invalid Prompt/);
assert.throws(() => renderAgentPrompt({ id: 'issue-audit', version: 'v1', variant: 'cursor', context: {} }), /Missing Prompt/);
assert.throws(() => renderAgentPrompt({ id: 'issue-audit', version: 'v1', context: {} }), /Missing required Prompt variant/);

const acceptance = renderAcceptancePrompt({
  issue: { number: 17 }, stage: 'pre-merge', target_ref: 'sha', deployment: null,
  criteria: [{ criterion: 'SC-01', text: 'works' }], requirement_body: 'report',
});
assert.match(acceptance.text, /Do not add, remove, rename, rewrite, weaken/);
assert.match(acceptance.text, /"target_ref": "sha"/);
assert.equal(acceptance.template_version, 'v1');
const candidate = candidateIssue(issue, 'Bug: fixed', 'body', ['bug', 'ci']);
assert.deepEqual(candidate.labels.map((value) => value.name).sort(), ['bug', 'ci', 'in-progress']);
assert.deepEqual(issue.labels.map((value) => value.name), ['bug', 'web', 'in-progress']);

assert.deepEqual(Object.keys(issueAuditTools(issue, 'example/repo')).sort(), ['comment_target_issue', 'read_target_issue', 'update_target_issue']);
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
console.log('agent library self-test: passed');