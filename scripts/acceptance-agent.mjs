#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from './agent-workflow-telemetry.mjs';
import { renderAcceptancePrompt } from './lib/agent/tasks/acceptance.mjs';
import { promptTelemetry } from './lib/agent/telemetry/prompt.mjs';
import { runClaudeCli, normalizeClaudeUsage } from './lib/agent/providers/claude-code.mjs';
import { loadCursorSdk, selectCursorModel, normalizeCursorUsage, normalizeCursorCost } from './lib/agent/providers/cursor.mjs';

function promptFor(context) {
  return renderAcceptancePrompt(context).text;
}

function parseJsonText(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('Acceptance Agent returned empty output');
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Acceptance Agent output did not contain valid JSON');
  }
}

function requestedCursorModel() {
  return {
    id: process.env.CURSOR_MODEL || 'composer-2.5',
    fast: String(process.env.CURSOR_MODEL_FAST || 'true').toLowerCase() !== 'false',
  };
}

async function runCursor(context, workspace) {
  if (!process.env.CURSOR_API_KEY) throw new Error('CURSOR_API_KEY is required from the cursor GitHub Environment');
  const sdk = await loadCursorSdk();
  const selection = selectCursorModel(await sdk.Cursor.models.list());
  const store = new sdk.JsonlLocalAgentStore(path.join(process.env.RUNNER_TEMP || workspace, 'acceptance-cursor-store'));
  const agent = await sdk.Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    name: 'nession-acceptance-' + context.issue.number + '-' + context.stage,
    model: selection,
    tools: ['read', 'grep', 'glob', 'ls'],
    local: { cwd: workspace, settingSources: [], store },
  });
  const startedAt = new Date();
  try {
    const run = await agent.send(promptFor(context));
    let turns = 0;
    const toolCalls = [];
    for await (const event of run.stream()) {
      if (event.type === 'usage') turns += 1;
      if (event.type === 'tool_call' && event.status === 'running') toolCalls.push(event.name);
    }
    const result = await run.wait();
    let billed = null;
    try { billed = await agent.getUsage(); } catch {}
    const usage = normalizeCursorUsage(result.usage);
    const costs = normalizeCursorCost(billed);
    const meta = {
      provider: 'cursor',
      model: { id: selection.id, fast: requestedCursorModel().fast, params: selection.params ?? [] },
      run_id: result.id ?? run.id ?? null,
      request_id: result.requestId ?? run.requestId ?? null,
      status: result.status,
      turns,
      model_requests: turns,
      tool_calls: toolCalls,
      tools_observed: true,
      tokens: usage,
      cost: {
        raw_usd: costs.raw_usd,
        charged_usd: costs.charged_usd,
        estimated_usd: null,
      },
      timing: {
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        agent_duration_ms: result.durationMs ?? run.durationMs ?? (Date.now() - startedAt.getTime()),
      },
    };
    if (result.status !== 'finished') {
      const error = new Error('Cursor Acceptance Agent finished with status ' + result.status + ': ' + (result.error?.message || 'unknown error'));
      error.agentMeta = meta;
      throw error;
    }
    return { result: parseJsonText(result.result), meta };
  } finally {
    if (typeof agent[Symbol.asyncDispose] === 'function') await agent[Symbol.asyncDispose]();
    else agent.close?.();
  }
}

function claudeUsage(envelope) {
  return normalizeClaudeUsage(envelope);
}

function runDeepSeek(context, workspace) {
  if (!process.env.ANTHROPIC_BASE_URL) throw new Error('ANTHROPIC_BASE_URL is required from the deepseek GitHub Environment');
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required from the deepseek GitHub Environment');
  }
  const model = process.env.ACCEPTANCE_CLAUDE_MODEL || 'claude-sonnet-5';
  const startedAt = new Date();
  const { proc, parsed: envelope } = runClaudeCli({
    prompt: promptFor(context), model,
    maxTurns: process.env.ACCEPTANCE_MAX_TURNS || '20',
    allowedTools: 'Read,Glob,Grep',
    disallowedTools: 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,mcp__playwright__*',
    cwd: workspace,
  });
  if (!envelope) throw new Error('Claude Code failed without a parseable response');
  const meta = {
    provider: 'deepseek',
    model: {
      id: process.env.ANTHROPIC_MODEL || 'gateway-default',
      request_model: model,
      backend_mapping: 'claude-sonnet* -> deepseek-flash',
    },
    run_id: envelope.session_id ?? envelope.sessionId ?? null,
    request_id: null,
    status: proc.status === 0 ? 'finished' : 'error',
    turns: envelope.num_turns ?? envelope.numTurns ?? null,
    model_requests: null,
    tool_calls: null,
    tools_observed: false,
    tokens: claudeUsage(envelope),
    cost: {
      raw_usd: null,
      charged_usd: null,
      estimated_usd: null,
    },
    timing: {
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      agent_duration_ms: envelope.duration_ms ?? envelope.durationMs ?? (Date.now() - startedAt.getTime()),
    },
  };
  if (proc.status !== 0) {
    const error = new Error('Claude Code exited ' + proc.status + ': ' + [proc.stderr?.trim(), envelope.result].filter(Boolean).join('\n'));
    error.agentMeta = meta;
    throw error;
  }
  return { result: parseJsonText(envelope.result), meta };
}

export async function runAcceptanceAgent(context, provider, workspace) {
  if (!context.criteria?.length) return { result: { criteria: [] }, meta: null };
  if (provider === 'cursor') return runCursor(context, workspace);
  if (provider === 'deepseek') return runDeepSeek(context, workspace);
  throw new Error('unsupported Acceptance Agent provider: ' + provider);
}

function telemetryInput(context, providerMeta, result, status = 'completed') {
  const counts = { Pass: 0, Pending: 0, Fail: 0, 'N/A': 0 };
  for (const criterion of result?.criteria ?? []) {
    if (Object.hasOwn(counts, criterion.result)) counts[criterion.result] += 1;
  }
  return {
    workflow_id: 'requirement-acceptance',
    github_workflow: process.env.GITHUB_WORKFLOW || 'Acceptance',
    job: 'execute',
    task: {
      id: 'issue-' + context.issue.number + '-' + context.stage,
      type: 'acceptance',
      issue: context.issue.number,
      stage: context.stage,
      target_ref: context.target_ref,
      deployment: context.deployment || null,
    },
    agent: {
      provider: providerMeta.provider,
      prompt: promptTelemetry(renderAcceptancePrompt(context)),
      model: providerMeta.model,
      run_id: providerMeta.run_id,
      request_id: providerMeta.request_id,
      status: providerMeta.status,
    },
    execution: {
      turns: providerMeta.turns,
      model_requests: providerMeta.model_requests,
      tool_calls: providerMeta.tool_calls,
      tools_observed: providerMeta.tools_observed,
    },
    tokens: providerMeta.tokens,
    cost: providerMeta.cost,
    timing: providerMeta.timing,
    result: {
      status,
      pass: counts.Pass,
      pending: counts.Pending,
      fail: counts.Fail,
      na: counts['N/A'],
    },
  };
}

function selfTest() {
  const context = {
    issue: { number: 1360, title: 'Requirement: fixture' },
    stage: 'staging',
    target_ref: 'abc123',
    deployment: 'staging',
    ci_evidence: {
      schema_version: 1,
      kind: 'acceptance_ci_evidence',
      target_sha: 'abc123',
      direct_runs: [{ id: 42, name: 'E2E Tests', head_sha: 'abc123', status: 'completed', conclusion: 'success' }],
      pull_requests: [],
    },
    criteria: [{ criterion: 'SC-01', text: 'works', stage: 'staging' }],
    requirement_body: 'untrusted requirement',
  };
  const prompt = promptFor(context);
  assert.match(prompt, /Do not add, remove, rename, rewrite, weaken, substitute, reinterpret, or re-stage/);
  assert.match(prompt, /untrusted inputs/);
  assert.match(prompt, /"ci_evidence"/);
  assert.match(prompt, /"id": 42/);
  assert.deepEqual(parseJsonText('{"criteria":[]}'), { criteria: [] });
  assert.deepEqual(parseJsonText('```json\n{"criteria":[]}\n```'), { criteria: [] });
  const catalog = [{ id: 'composer-2.5', parameters: [{ id: 'fast', values: [{ value: 'true' }] }] }];
  assert.deepEqual(selectCursorModel(catalog, { id: 'composer-2.5', fast: true }), {
    id: 'composer-2.5',
    params: [{ id: 'fast', value: 'true' }],
  });
  assert.throws(() => selectCursorModel([], { id: 'composer-2.5', fast: true }), /no fallback/i);
  assert.equal(claudeUsage({ usage: { input_tokens: 2, output_tokens: 1 } }).input, 2);
  console.log('acceptance-agent self-test: 9 cases passed');
}

async function main() {
  if (process.argv[2] === 'self-test') return selfTest();
  const [contextFile, provider, workspace, outFile, telemetryFile] = process.argv.slice(2);
  if (!contextFile || !provider || !workspace || !outFile) {
    throw new Error('usage: node scripts/acceptance-agent.mjs CONTEXT PROVIDER WORKSPACE OUT [TELEMETRY_OUT]');
  }
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  try {
    const { result, meta } = await runAcceptanceAgent(context, provider, workspace);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
    if (telemetryFile && meta) {
      writeAgentWorkflowTelemetry(telemetryFile, buildAgentWorkflowTelemetry(telemetryInput(context, meta, result)));
    }
  } catch (error) {
    if (telemetryFile) {
      const fallbackMeta = error?.agentMeta ?? {
        provider,
        model: provider === 'cursor'
          ? requestedCursorModel()
          : { id: process.env.ANTHROPIC_MODEL || 'gateway-default', request_model: process.env.ACCEPTANCE_CLAUDE_MODEL || 'claude-sonnet-5' },
        run_id: null,
        request_id: null,
        status: 'error',
        turns: null,
        model_requests: null,
        tool_calls: null,
        tools_observed: false,
        tokens: {},
        cost: {},
        timing: {
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          agent_duration_ms: null,
        },
      };
      writeAgentWorkflowTelemetry(
        telemetryFile,
        buildAgentWorkflowTelemetry(telemetryInput(context, fallbackMeta, { criteria: [] }, 'agent-error')),
      );
    }
    throw error;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
