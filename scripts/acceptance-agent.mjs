#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from './agent-workflow-telemetry.mjs';
import { normalizeNativeTrace, writeExecutionTrace } from './lib/agent/telemetry/execution-trace.mjs';
import { renderAcceptancePrompt } from './lib/agent/tasks/acceptance.mjs';
import { promptTelemetry } from './lib/agent/telemetry/prompt.mjs';
import { providerScopedRunName } from './lib/agent/telemetry/run-name.mjs';
import { runClaudeCli, normalizeClaudeUsage } from './lib/agent/providers/claude-code.mjs';
import { runCursorSession, selectCursorModel } from './lib/agent/providers/cursor.mjs';

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
  const { result, meta } = await runCursorSession({
    apiKey: process.env.CURSOR_API_KEY,
    name: 'nession-acceptance-' + context.issue.number + '-' + context.stage,
    requestedModel: requestedCursorModel(),
    tools: ['read', 'grep', 'glob', 'ls'],
    workspace,
    storePath: path.join(process.env.RUNNER_TEMP || workspace, 'acceptance-cursor-store'),
    prompt: promptFor(context),
  });
  const normalized = {
    provider: 'cursor',
    model: meta.model, run_id: meta.run_id, request_id: meta.request_id,
    status: meta.status, turns: meta.turns, model_requests: meta.turns,
    tool_calls: meta.tool_calls, tools_observed: true, native_events: meta.native_events,
    tokens: meta.usage, cost: { ...meta.cost, estimated_usd: null },
    timing: { started_at: meta.started_at, finished_at: meta.finished_at, agent_duration_ms: meta.duration_ms },
  };
  if (result.status !== 'finished') {
    const error = new Error('Cursor Acceptance Agent finished with status ' + result.status + ': ' + (result.error?.message || 'unknown error'));
    error.agentMeta = normalized;
    throw error;
  }
  return { result: parseJsonText(result.result), meta: normalized };
}

function requestedClaudeGatewayModel(backend, env = process.env) {
  const model = backend === 'qwen'
    ? (env.ACCEPTANCE_CLAUDE_MODEL || env.ANTHROPIC_MODEL)
    : (env.ACCEPTANCE_CLAUDE_MODEL || 'claude-sonnet-5');
  if (backend === 'qwen' && (!model || /^claude-(?:opus|sonnet|haiku)/i.test(model))) {
    throw new Error('Qwen Environment must explicitly set a Qwen model via ACCEPTANCE_CLAUDE_MODEL or ANTHROPIC_MODEL');
  }
  return model;
}

function claudeUsage(envelope) {
  return normalizeClaudeUsage(envelope);
}

function runClaudeGateway(context, workspace, backend) {
  if (!process.env.ANTHROPIC_BASE_URL) throw new Error('ANTHROPIC_BASE_URL is required from the selected Claude Gateway Environment');
  if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required from the selected Claude Gateway Environment');
  }
  const model = requestedClaudeGatewayModel(backend);
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
    provider: backend === 'qwen' ? 'claude-code' : 'deepseek',
    model: {
      id: backend === 'qwen' ? model : (process.env.ANTHROPIC_MODEL || 'gateway-default'),
      request_model: model,
      backend_mapping: backend === 'qwen' ? 'qwen-configured-gateway' : 'claude-sonnet* -> deepseek-flash',
    },
    run_id: envelope.session_id ?? envelope.sessionId ?? null,
    request_id: null,
    status: proc.status === 0 ? 'finished' : 'error',
    turns: envelope.num_turns ?? envelope.numTurns ?? null,
    model_requests: null,
    tool_calls: null,
    tools_observed: false,
    native_events: [], // JSON-only Claude invocation does not expose the tool lifecycle.
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
  if (provider === 'deepseek' || provider === 'qwen') return runClaudeGateway(context, workspace, provider);
  throw new Error('unsupported Acceptance Agent provider: ' + provider);
}

function telemetryInput(context, providerMeta, result, status = 'completed') {
  const counts = { Pass: 0, Pending: 0, Fail: 0, 'N/A': 0 };
  for (const criterion of result?.criteria ?? []) {
    if (Object.hasOwn(counts, criterion.result)) counts[criterion.result] += 1;
  }
  return {
    workflow_id: process.env.NSESSION_AGENT_WORKFLOW_ID || 'requirement-acceptance',
    github_workflow: process.env.GITHUB_WORKFLOW || 'Acceptance',
    unique_run_name: providerScopedRunName({
      workflowId: process.env.NSESSION_AGENT_WORKFLOW_ID || 'requirement-acceptance',
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      taskId: 'issue-' + context.issue.number + '-' + context.stage,
      provider: providerMeta.provider,
    }),
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
      // Legacy acceptance runs still use the shared cursor/deepseek Environments;
      // do not misidentify them as the future per-ID Registry instances.
      id: 'legacy-acceptance-' + providerMeta.provider,
      role: 'acceptor',
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

function writeAcceptanceTelemetry(file, context, providerMeta, result, status = 'completed') {
  const summary = buildAgentWorkflowTelemetry(telemetryInput(context, providerMeta, result, status));
  writeAgentWorkflowTelemetry(file, summary);
  const nativeEvents = providerMeta.native_events ?? [];
  const seen = (type) => nativeEvents.some(event => event.type === type);
  const coverage = {
    model: seen('usage') ? 'observed' : 'unobserved',
    tools: seen('tool_call') ? 'partial' : 'unobserved',
    skills: 'unobserved',
    mcp: 'unobserved',
  };
  // Claude JSON mode cannot support per-tool/Skill claims: an empty trace
  // records the gap explicitly, rather than inventing observed=0.
  const nativeProvider = providerMeta.provider === 'cursor' ? 'cursor' : 'claude-code';
  const trace = normalizeNativeTrace(nativeProvider, nativeEvents, summary, coverage);
  writeExecutionTrace(path.join(path.dirname(file), 'agent-execution-trace.json'), trace);
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
  assert.equal(claudeUsage({}).input, null);
  assert.equal(claudeUsage({ modelUsage: { modelA: { inputTokens: 5 } } }).input, 5);
  assert.equal(requestedClaudeGatewayModel('qwen', { ANTHROPIC_MODEL:'qwen3-coder-plus' }), 'qwen3-coder-plus');
  assert.equal(requestedClaudeGatewayModel('qwen', { ACCEPTANCE_CLAUDE_MODEL:'qwen3.7-plus' }), 'qwen3.7-plus');
  assert.throws(() => requestedClaudeGatewayModel('qwen', {}), /Qwen Environment/);
  assert.throws(() => requestedClaudeGatewayModel('qwen', {ANTHROPIC_MODEL:'claude-sonnet-5'}), /Qwen Environment/);
  assert.equal(requestedClaudeGatewayModel('deepseek', {}), 'claude-sonnet-5');
  console.log('acceptance-agent self-test: 14 cases passed');
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
      writeAcceptanceTelemetry(telemetryFile, context, meta, result);
    }
  } catch (error) {
    if (telemetryFile) {
      const fallbackMeta = error?.agentMeta ?? {
        provider: provider === 'qwen' ? 'claude-code' : provider,
        model: provider === 'cursor'
          ? requestedCursorModel()
          : { id: process.env.ANTHROPIC_MODEL || 'gateway-default',
              request_model: provider === 'qwen' ? (process.env.ACCEPTANCE_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || null)
                : (process.env.ACCEPTANCE_CLAUDE_MODEL || 'claude-sonnet-5') },
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
      writeAcceptanceTelemetry(telemetryFile, context, fallbackMeta, { criteria: [] }, 'agent-error');
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
