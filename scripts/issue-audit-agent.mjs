#!/usr/bin/env node

import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { auditIssue } from './issue-contract.mjs';
import { fetchGitHubIssue as fetchIssue } from './lib/agent/tools/gh/issue/read.mjs';
import { normalizeClaudeUsage, runClaudeCli, buildClaudeCliArgs } from './lib/agent/providers/claude-code.mjs';
import { renderIssueAuditPrompt, applyIssueAuditProposal } from './lib/agent/tasks/issue-audit.mjs';
import { promptTelemetry } from './lib/agent/telemetry/prompt.mjs';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from './agent-workflow-telemetry.mjs';

function envNumber(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function extractUsage(result) {
  const usage = normalizeClaudeUsage(result);
  return {
    input_tokens: usage.input, output_tokens: usage.output,
    cache_read_tokens: usage.cache_read, cache_write_tokens: usage.cache_write,
  };
}

function estimateCost(usage) {
  const rates = {
    input: envNumber('LLM_INPUT_USD_PER_MTOK'),
    output: envNumber('LLM_OUTPUT_USD_PER_MTOK'),
    cacheRead: envNumber('LLM_CACHE_READ_USD_PER_MTOK'),
    cacheWrite: envNumber('LLM_CACHE_WRITE_USD_PER_MTOK'),
  };
  if (Object.values(rates).every((x) => x == null)) return { usd: null, rates };
  const usd = (
    usage.input_tokens * (rates.input ?? 0) +
    usage.output_tokens * (rates.output ?? 0) +
    usage.cache_read_tokens * (rates.cacheRead ?? 0) +
    usage.cache_write_tokens * (rates.cacheWrite ?? 0)
  ) / 1_000_000;
  return { usd, rates };
}

function ensureProviderConfig() {
  const missing = [];
  if (!process.env.ANTHROPIC_BASE_URL) missing.push('ANTHROPIC_BASE_URL (deepseek Environment variable)');
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    missing.push('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY (deepseek Environment secret)');
  }
  if (missing.length) {
    throw new Error(`DeepSeek Claude Code configuration is incomplete:\n- ${missing.join('\n- ')}\nFix the GitHub Environment named deepseek; this workflow will not fall back to another provider.`);
  }
}

function promptFor(issue, audit) {
  return renderIssueAuditPrompt(issue, audit, 'deepseek').text;
}

function appendSummary(record) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const usage = record.agent?.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  const lines = [
    '## Issue Audit Agent',
    '',
    `- Issue: #${record.issue.number} - ${record.issue.title}`,
    `- Trigger: \`${record.trigger}\``,
    `- Result: **${record.result}**`,
    `- Claude invoked: ${record.agent?.invoked ? 'yes' : 'no'}`,
  ];
  if (record.agent?.invoked) {
    lines.push(
      `- DeepSeek configured model: \`${record.agent.model ?? 'unknown'}\``,
      `- Claude request model: \`${record.agent.claude_request_model ?? 'unknown'}\``,
      `- Backend mapping: \`${record.agent.backend_mapping ?? 'unknown'}\``,
      `- Session: \`${record.agent.session_id ?? 'unknown'}\``,
      `- Input tokens: ${usage.input_tokens}`,
      `- Output tokens: ${usage.output_tokens}`,
      `- Cache read tokens: ${usage.cache_read_tokens}`,
      `- Cache write tokens: ${usage.cache_write_tokens}`,
      `- Claude list-equivalent cost: ${record.agent.reported_cost_usd == null ? 'N/A' : '$' + record.agent.reported_cost_usd.toFixed(6)}`,
      `- Cost basis: ${record.agent.reported_cost_basis ?? 'unknown'}`,
      `- Estimated cost: ${record.agent.estimated_cost_usd == null ? 'N/A' : '$' + record.agent.estimated_cost_usd.toFixed(6)}`,
      `- Turns: ${record.agent.num_turns ?? 'N/A'}`,
      `- Duration: ${record.agent.duration_ms == null ? 'N/A' : record.agent.duration_ms + ' ms'}`,
    );
  }
  if (record.errors?.length) lines.push('', '### Remaining contract findings', '', ...record.errors.map((e) => `- ${e}`));
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

function writeRecord(outDir, record) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'issue-' + record.issue.number + '-usage.json');
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  if (record.agent?.invoked) {
    const agent = record.agent;
    writeAgentWorkflowTelemetry(
      path.join(outDir, 'agent-telemetry.json'),
      buildAgentWorkflowTelemetry({
        workflow_id: 'issue-audit',
        github_workflow: process.env.GITHUB_WORKFLOW || 'Issue Audit Agent',
        job: 'agent',
        task: {
          id: 'issue-' + record.issue.number,
          type: 'issue-audit',
          issue: record.issue.number,
        },
        agent: {
          provider: agent.provider || 'deepseek',
          prompt: promptTelemetry(renderIssueAuditPrompt({ number: record.issue.number, url: '', labels: [], body: '' }, { errors: [] }, 'deepseek')),
          model: {
            id: agent.model ?? null,
            request_model: agent.claude_request_model ?? null,
            backend_mapping: agent.backend_mapping ?? null,
          },
          run_id: agent.session_id ?? null,
          request_id: null,
          status: record.result === 'agent-error' ? 'error' : 'finished',
        },
        execution: {
          turns: agent.num_turns ?? null,
          model_requests: null,
          tool_calls: null,
          tools_observed: false,
        },
        tokens: agent.usage ?? {},
        cost: {
          raw_usd: null,
          charged_usd: null,
          estimated_usd: agent.estimated_cost_usd ?? null,
        },
        timing: {
          started_at: agent.started_at ?? new Date().toISOString(),
          finished_at: agent.finished_at ?? new Date().toISOString(),
          agent_duration_ms: agent.duration_ms ?? null,
        },
        result: { status: record.result },
      }),
    );
  }
  appendSummary(record);
  return file;
}

function claudeRequestModel() {
  return process.env.ISSUE_AUDIT_CLAUDE_MODEL || 'claude-sonnet-5';
}

function runAgent(issue) {
  ensureProviderConfig();
  const allowed = 'Read,Glob,Grep';
  const disallowed = 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,mcp__playwright__*';
  const audit = auditIssue(issue);
  const requestModel = claudeRequestModel();
  const { proc: result, parsed: envelope } = runClaudeCli({
    prompt: promptFor(issue, audit), model: requestModel,
    maxTurns: process.env.ISSUE_AUDIT_MAX_TURNS || '20',
    allowedTools: allowed, disallowedTools: disallowed,
  });
  if (result.error) throw result.error;
  const parsed = envelope;
  if (result.status !== 0) {
    const detail = [result.stderr?.trim(), parsed?.result, result.stdout?.trim()].filter(Boolean).join('\n');
    const error = new Error(`Claude Code exited ${result.status}: ${detail || 'unknown error'}`);
    error.claudeResult = parsed;
    throw error;
  }
  if (!parsed) throw new Error('Claude Code succeeded but returned no parseable JSON');
  return parsed;
}

async function selfTest() {
  const sample = {
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
    total_cost_usd: 0.01, session_id: 's1', num_turns: 2, duration_ms: 100,
  };
  assert.deepEqual(extractUsage(sample), { input_tokens: 10, output_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 3 });
  const modelUsage = { modelUsage: { deepseek: { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 5, cacheCreationInputTokens: 1 } } };
  assert.deepEqual(extractUsage(modelUsage), { input_tokens: 7, output_tokens: 2, cache_read_tokens: 5, cache_write_tokens: 1 });
  const oldRepo = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY ||= 'BestNathan/nession';
  const previous = process.env.ISSUE_AUDIT_CLAUDE_MODEL;
  process.env.ISSUE_AUDIT_CLAUDE_MODEL = 'claude-sonnet-5';
  const args = buildClaudeCliArgs({ prompt: promptFor({ number: 1, labels: [], body: '', url: 'https://example.test/1' }, { errors: [] }), model: claudeRequestModel(), maxTurns: 20, allowedTools: 'Read,Glob,Grep', disallowedTools: 'Bash' });
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5');
  assert.match(args[1], /By turn 8, stop investigating/);
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Bash');
  if (previous == null) delete process.env.ISSUE_AUDIT_CLAUDE_MODEL;
  else process.env.ISSUE_AUDIT_CLAUDE_MODEL = previous;
  if (oldRepo == null) delete process.env.GITHUB_REPOSITORY;
  else process.env.GITHUB_REPOSITORY = oldRepo;
  await import('./lib/agent/selftest.mjs');
  console.log('issue-audit-agent self-test: 4 cases passed');
}

async function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  const issueNumber = Number(process.argv[2]);
  const outDir = process.argv[3] || process.env.RUNNER_TEMP || '.issue-audit';
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue number is required');
  const trigger = process.env.ISSUE_AUDIT_TRIGGER || process.env.GITHUB_EVENT_NAME || 'manual';
  const issue = fetchIssue(issueNumber);
  if (String(issue.state).toUpperCase() !== 'OPEN') {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'skipped-closed', agent: { invoked: false }, errors: [] });
    return;
  }

  const before = auditIssue(issue);
  if (before.ok) {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'contract-pass', agent: { invoked: false }, errors: [] });
    return;
  }

  if (process.env.ISSUE_AUDIT_ALLOW_AGENT !== 'true') {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'agent-not-authorized', agent: { invoked: false }, errors: before.errors });
    return;
  }

  let claude;
  const agentStartedAt = new Date();
  try {
    claude = runAgent(issue);
    await applyIssueAuditProposal(issue, claude);
  } catch (error) {
    const afterIssue = fetchIssue(issueNumber);
    const after = auditIssue(afterIssue);
    const message = error instanceof Error ? error.message : String(error);
    const failed = claude ?? (error && typeof error === 'object' ? error.claudeResult ?? null : null);
    const usage = failed ? extractUsage(failed) : { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const estimated = estimateCost(usage);
    writeRecord(outDir, {
      schema_version: 1,
      issue: { number: afterIssue.number, title: afterIssue.title, url: afterIssue.url },
      trigger,
      result: 'agent-error',
      agent: {
        invoked: true,
        provider: 'deepseek',
        model: process.env.ANTHROPIC_MODEL || 'gateway-default',
        claude_request_model: claudeRequestModel(),
        backend_mapping: 'claude-sonnet* -> deepseek-flash',
        session_id: failed?.session_id ?? failed?.sessionId ?? null,
        num_turns: failed?.num_turns ?? failed?.numTurns ?? null,
        started_at: agentStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: failed?.duration_ms ?? failed?.durationMs ?? (Date.now() - agentStartedAt.getTime()),
        usage,
        reported_cost_usd: failed?.total_cost_usd != null && Number.isFinite(Number(failed.total_cost_usd)) ? Number(failed.total_cost_usd) : null,
        reported_cost_basis: 'Claude list-equivalent from the request model; not the DeepSeek bill',
        estimated_cost_usd: estimated.usd,
        pricing_usd_per_mtok: estimated.rates,
        terminal_reason: failed?.terminal_reason ?? failed?.subtype ?? null,
        error: message,
      },
      errors: after.errors,
    });
    throw error;
  }

  const usage = extractUsage(claude);
  const estimated = estimateCost(usage);
  const afterIssue = fetchIssue(issueNumber);
  const after = auditIssue(afterIssue);
  const record = {
    schema_version: 1,
    issue: { number: afterIssue.number, title: afterIssue.title, url: afterIssue.url },
    trigger,
    result: after.ok ? 'repaired' : 'contract-fail',
    agent: {
      invoked: true,
      provider: 'deepseek',
      model: process.env.ANTHROPIC_MODEL || 'gateway-default',
      claude_request_model: claudeRequestModel(),
      backend_mapping: 'claude-sonnet* -> deepseek-flash',
      session_id: claude.session_id ?? claude.sessionId ?? null,
      num_turns: claude.num_turns ?? claude.numTurns ?? null,
      started_at: agentStartedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: claude.duration_ms ?? claude.durationMs ?? (Date.now() - agentStartedAt.getTime()),
      usage,
      reported_cost_usd: claude.total_cost_usd != null && Number.isFinite(Number(claude.total_cost_usd)) ? Number(claude.total_cost_usd) : null,
      reported_cost_basis: 'Claude list-equivalent from the request model; not the DeepSeek bill',
      estimated_cost_usd: estimated.usd,
      pricing_usd_per_mtok: estimated.rates,
    },
    errors: after.errors,
  };
  writeRecord(outDir, record);
  if (!after.ok) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  }
}
