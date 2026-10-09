#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { auditIssue } from './issue-contract.mjs';
import { fetchGitHubIssue as fetchIssue, createIssueReadTool } from './lib/agent/tools/gh/issue/read.mjs';
import { createIssueUpdateTool, candidateIssue, issueLabelNames as labelNames } from './lib/agent/tools/gh/issue/update.mjs';
import { createIssueCommentTool } from './lib/agent/tools/gh/issue/comment.mjs';
import { renderIssueAuditPrompt } from './lib/agent/tasks/issue-audit.mjs';
import { loadCursorSdk, normalizeCursorSdkModule, selectCursorModel as modelSelectionFromCatalog, normalizeCursorUsage, normalizeCursorCost } from './lib/agent/providers/cursor.mjs';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from './agent-workflow-telemetry.mjs';

function ensureCursorConfig() {
  if (!process.env.CURSOR_API_KEY) {
    throw new Error('Cursor Issue Audit configuration is incomplete: CURSOR_API_KEY is required from GitHub Environment "cursor". No provider fallback is allowed.');
  }
  if (!process.env.CURSOR_SDK_ROOT) {
    throw new Error('CURSOR_SDK_ROOT is required; install @cursor/sdk before invoking the Cursor Issue Audit runner.');
  }
}

function requestedModel() {
  return {
    id: process.env.CURSOR_MODEL || 'composer-2.5',
    fast: (process.env.CURSOR_MODEL_FAST || 'true').toLowerCase() !== 'false',
  };
}

function cursorSdkPlatformPackage(platform = process.platform, arch = process.arch) {
  return `@cursor/sdk-${platform}-${arch}`;
}

function cursorRipgrepBinary(platform = process.platform) {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function executablePath(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return path.resolve(file);
  } catch {
    return null;
  }
}

function resolveExecutableOnPath(binary, searchPath = process.env.PATH || '') {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const resolved = executablePath(path.join(directory, binary));
    if (resolved) return resolved;
  }
  return null;
}

function resolveBundledCursorRipgrepPath(root = process.env.CURSOR_SDK_ROOT) {
  if (!root) return null;
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const sdkEntry = requireFromRoot.resolve('@cursor/sdk');
  const packageName = cursorSdkPlatformPackage();
  let manifest;
  try {
    manifest = requireFromRoot.resolve(`${packageName}/package.json`, {
      paths: [path.dirname(sdkEntry)],
    });
  } catch {
    return null;
  }
  return executablePath(path.join(path.dirname(manifest), 'bin', cursorRipgrepBinary()));
}

function ensureCursorRipgrepPath() {
  const configured = process.env.CURSOR_RIPGREP_PATH;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(`CURSOR_RIPGREP_PATH must be absolute: ${configured}\nFix: unset it to use the bundled Cursor SDK ripgrep, or set it to an absolute rg executable path.`);
    }
    const resolved = executablePath(configured);
    if (!resolved) {
      throw new Error(`CURSOR_RIPGREP_PATH is not executable: ${configured}\nFix: unset it to use the bundled Cursor SDK ripgrep, or point it at an executable rg binary.`);
    }
    return resolved;
  }

  const bundled = resolveBundledCursorRipgrepPath();
  const fromPath = resolveExecutableOnPath(cursorRipgrepBinary());
  const resolved = bundled || fromPath;
  if (!resolved) {
    const packageName = cursorSdkPlatformPackage();
    throw new Error(`Cursor SDK ripgrep bootstrap failed: no executable rg was found in ${packageName} or PATH.\nFix: reinstall @cursor/sdk under CURSOR_SDK_ROOT so its platform package is present, or set CURSOR_RIPGREP_PATH to an absolute rg executable path.`);
  }

  process.env.CURSOR_RIPGREP_PATH = resolved;
  return resolved;
}

async function loadCursorSdkForAudit() {
  ensureCursorRipgrepPath();
  return loadCursorSdk();
}

function promptFor(issue, audit) {
  return renderIssueAuditPrompt(issue, audit, 'cursor').text;
}

function createCustomTools(issue) {
  return {
    read_target_issue: createIssueReadTool(issue),
    update_target_issue: createIssueUpdateTool(issue),
    comment_target_issue: createIssueCommentTool(issue),
  };
}

function normalizeUsage(usage) {
  const value = normalizeCursorUsage(usage);
  return {
    input_tokens: value.input, output_tokens: value.output,
    cache_read_tokens: value.cache_read, cache_write_tokens: value.cache_write,
    reasoning_tokens: value.reasoning, total_tokens: value.total ?? 0,
  };
}

function normalizeCost(usageResult) {
  const cost = normalizeCursorCost(usageResult);
  return { raw_cost_usd: cost.raw_usd, charged_cost_usd: cost.charged_usd };
}

function appendSummary(record) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const usage = record.agent?.usage ?? {};
  const lines = [
    '## Issue Audit Agent', '',
    `- Issue: #${record.issue.number} — ${record.issue.title}`,
    `- Trigger: \`${record.trigger}\``,
    `- Provider: \`${record.agent?.provider ?? 'cursor'}\``,
    `- Result: **${record.result}**`,
  ];
  if (record.agent?.invoked) {
    lines.push(
      `- Model: \`${record.agent.model?.id ?? 'unknown'}\``,
      `- Fast: \`${record.agent.model?.fast ?? 'unknown'}\``,
      `- Agent ID: \`${record.agent.agent_id ?? 'unknown'}\``,
      `- Run ID: \`${record.agent.run_id ?? 'unknown'}\``,
      `- Request ID: \`${record.agent.request_id ?? 'unknown'}\``,
      `- Turns observed: ${record.agent.turns ?? 'N/A'}`,
      `- Duration: ${record.agent.duration_ms == null ? 'N/A' : record.agent.duration_ms + ' ms'}`,
      `- Input tokens: ${usage.input_tokens ?? 0}`,
      `- Output tokens: ${usage.output_tokens ?? 0}`,
      `- Cache read tokens: ${usage.cache_read_tokens ?? 0}`,
      `- Cache write tokens: ${usage.cache_write_tokens ?? 0}`,
      `- Total tokens: ${usage.total_tokens ?? 0}`,
      `- Raw cost: ${record.agent.raw_cost_usd == null ? 'N/A' : '$' + record.agent.raw_cost_usd.toFixed(6)}`,
      `- Charged cost: ${record.agent.charged_cost_usd == null ? 'N/A' : '$' + record.agent.charged_cost_usd.toFixed(6)}`,
    );
  }
  if (record.errors?.length) lines.push('', '### Remaining contract findings', '', ...record.errors.map((error) => `- ${error}`));
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
          provider: agent.provider || 'cursor',
          model: agent.model ?? null,
          run_id: agent.run_id ?? agent.agent_id ?? null,
          request_id: agent.request_id ?? null,
          status: agent.status ?? (record.result === 'agent-error' ? 'error' : 'finished'),
        },
        execution: {
          turns: agent.turns ?? null,
          model_requests: agent.turns ?? null,
          tool_calls: agent.tool_calls ?? null,
          tools_observed: Array.isArray(agent.tool_calls),
        },
        tokens: agent.usage ?? {},
        cost: {
          raw_usd: agent.raw_cost_usd ?? null,
          charged_usd: agent.charged_cost_usd ?? null,
          estimated_usd: null,
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

async function runCursorAgent(issue, outDir) {
  ensureCursorConfig();
  const sdk = await loadCursorSdkForAudit();
  const catalog = await sdk.Cursor.models.list();
  const requested = requestedModel();
  const selection = modelSelectionFromCatalog(catalog, requested);
  const store = new sdk.JsonlLocalAgentStore(path.join(outDir, 'cursor-store'));
  const customTools = createCustomTools(issue);
  const audit = auditIssue(issue);

  const agent = await sdk.Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    name: `nession-issue-audit-${issue.number}`,
    model: selection,
    tools: ['read', 'grep', 'glob', 'ls', 'mcp'],
    local: {
      cwd: process.cwd(),
      settingSources: [],
      store,
      customTools,
    },
  });

  const startedAt = new Date();
  try {
    const run = await agent.send(promptFor(issue, audit));
    let turns = 0;
    let availableTools = [];
    const toolCalls = [];
    for await (const event of run.stream()) {
      if (event.type === 'usage') turns += 1;
      if (event.type === 'system' && Array.isArray(event.tools)) availableTools = event.tools;
      if (event.type === 'tool_call' && event.status === 'running') toolCalls.push(event.name);
    }
    const result = await run.wait();
    let billed = null;
    try { billed = await agent.getUsage(); } catch {}
    const usage = normalizeUsage(result.usage);
    const cost = normalizeCost(billed);
    const meta = {
      invoked: true,
      provider: 'cursor',
      model: { id: selection.id, fast: requested.fast, params: selection.params ?? [] },
      agent_id: agent.agentId,
      run_id: result.id ?? run.id ?? null,
      request_id: result.requestId ?? run.requestId ?? null,
      turns,
      available_tools: availableTools,
      tool_calls: toolCalls,
      final_text: typeof result.result === 'string' ? result.result.slice(0, 4000) : null,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: result.durationMs ?? run.durationMs ?? (Date.now() - startedAt.getTime()),
      usage,
      raw_cost_usd: cost.raw_cost_usd,
      charged_cost_usd: cost.charged_cost_usd,
      status: result.status,
      error: result.error ?? null,
    };
    if (result.status !== 'finished') {
      const error = new Error(`Cursor Agent finished with status ${result.status}: ${result.error?.message ?? 'unknown error'}`);
      error.cursorMeta = meta;
      throw error;
    }
    return meta;
  } finally {
    if (typeof agent[Symbol.asyncDispose] === 'function') await agent[Symbol.asyncDispose]();
    else agent.close?.();
  }
}

function selfTest() {
  assert.equal(cursorSdkPlatformPackage('linux', 'x64'), '@cursor/sdk-linux-x64');
  assert.equal(cursorSdkPlatformPackage('darwin', 'arm64'), '@cursor/sdk-darwin-arm64');
  assert.equal(cursorRipgrepBinary('win32'), 'rg.exe');
  assert.equal(cursorRipgrepBinary('linux'), 'rg');
  assert.equal(normalizeCursorSdkModule({ Cursor: {}, Agent: {} }).Cursor != null, true);
  assert.equal(normalizeCursorSdkModule({ default: { Cursor: {}, Agent: {} } }).Agent != null, true);
  const restrictedTools = ['read', 'grep', 'glob', 'ls', 'mcp'];
  assert.equal(restrictedTools.includes('mcp'), true);
  assert.equal(restrictedTools.includes('shell'), false);
  const catalog = [{ id: 'composer-2.5', parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }] }];
  assert.deepEqual(modelSelectionFromCatalog(catalog, { id: 'composer-2.5', fast: true }), {
    id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }],
  });
  assert.throws(() => modelSelectionFromCatalog([], { id: 'composer-2.5', fast: true }), /no fallback/i);
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 10 }), {
    input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, reasoning_tokens: null, total_tokens: 10,
  });
  assert.deepEqual(normalizeCost({ cost: { rawCostCents: 123, chargedCents: 45 } }), { raw_cost_usd: 1.23, charged_cost_usd: 0.45 });
  const candidate = candidateIssue({ labels: [{ name: 'in-progress' }] }, 'Bug: example', 'body', ['bug', 'web']);
  assert.equal(candidate.title, 'Bug: example');
  assert.deepEqual(labelNames(candidate).sort(), ['bug', 'in-progress', 'web']);
  console.log('issue-audit-cursor self-test: 14 cases passed');
}

async function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  const issueNumber = Number(process.argv[2]);
  const outDir = process.argv[3] || process.env.RUNNER_TEMP || '.issue-audit';
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error('issue number is required');
  const trigger = process.env.ISSUE_AUDIT_TRIGGER || process.env.GITHUB_EVENT_NAME || 'manual';
  const issue = fetchIssue(issueNumber);

  if (String(issue.state).toUpperCase() !== 'OPEN') {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'skipped-closed', agent: { invoked: false, provider: 'cursor' }, errors: [] });
    return;
  }

  const before = auditIssue(issue);
  if (before.ok && process.env.ISSUE_AUDIT_FORCE_AGENT !== 'true') {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'contract-pass', agent: { invoked: false, provider: 'cursor' }, errors: [] });
    return;
  }

  if (process.env.ISSUE_AUDIT_ALLOW_AGENT !== 'true') {
    writeRecord(outDir, { schema_version: 1, issue: { number: issue.number, title: issue.title, url: issue.url }, trigger, result: 'agent-not-authorized', agent: { invoked: false, provider: 'cursor' }, errors: before.errors });
    return;
  }

  let meta;
  try {
    meta = await runCursorAgent(issue, outDir);
  } catch (error) {
    const afterIssue = fetchIssue(issueNumber);
    const after = auditIssue(afterIssue);
    writeRecord(outDir, {
      schema_version: 1,
      issue: { number: afterIssue.number, title: afterIssue.title, url: afterIssue.url },
      trigger,
      result: 'agent-error',
      agent: error?.cursorMeta ?? { invoked: true, provider: 'cursor', model: requestedModel(), error: error instanceof Error ? error.message : String(error) },
      errors: after.errors,
    });
    throw error;
  }

  const afterIssue = fetchIssue(issueNumber);
  const after = auditIssue(afterIssue);
  writeRecord(outDir, {
    schema_version: 1,
    issue: { number: afterIssue.number, title: afterIssue.title, url: afterIssue.url },
    trigger,
    result: after.ok ? 'repaired' : 'contract-fail',
    agent: meta,
    errors: after.errors,
  });
  if (!after.ok) process.exitCode = 2;
}

try { await main(); } catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
