#!/usr/bin/env node
// #2327: read-only E2E Failure Analysis runner. It validates a trusted dispatch
// request, renders the bounded Prompt, invokes the model with read-only tools,
// validates the bounded diagnosis and emits canonical Agent telemetry. It has
// no GitHub write, Store write, dispatch or Bug authority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from './agent-workflow-telemetry.mjs';
import { runClaudeCli, normalizeClaudeUsage } from './lib/agent/providers/claude-code.mjs';
import { normalizeNativeTrace, writeExecutionTrace } from './lib/agent/telemetry/execution-trace.mjs';
import { promptTelemetry } from './lib/agent/telemetry/prompt.mjs';
import { providerScopedRunName } from './lib/agent/telemetry/run-name.mjs';
import { parseModelJson, parseModelJsonWithRepair } from './lib/agent/tasks/model-json.mjs';
import {
  E2E_FAILURE_ANALYSIS_PROMPT_VERSION,
  e2eFailureAnalysisResult,
  renderE2eFailureAnalysisPrompt,
} from './lib/agent/tasks/e2e-failure-analysis.mjs';

const WORKFLOW_ID = 'agent-e2e-failure-analysis';
const MAX_TURNS = '12';
const ALLOWED_TOOLS = 'Read,Glob,Grep';
const DISALLOWED_TOOLS = 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,mcp__playwright__*';

function requestedGatewayModel() {
  const model = String(process.env.ANALYSIS_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || '').trim();
  if (!model) throw new Error('E2E failure analysis requires an explicit gateway model');
  return model;
}

function providerMeta(model, envelope, status, startedAt, nativeEvents = []) {
  return {
    provider: 'claude-code',
    model: { id: model, request_model: model, backend_mapping: 'qwen-configured-gateway' },
    run_id: envelope?.session_id ?? envelope?.sessionId ?? null,
    request_id: null,
    status,
    turns: envelope?.num_turns ?? envelope?.numTurns ?? null,
    model_requests: null,
    tool_calls: null,
    tools_observed: false,
    native_events: nativeEvents,
    tokens: normalizeClaudeUsage(envelope ?? {}),
    cost: { raw_usd: null, charged_usd: null, estimated_usd: null },
    timing: {
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      agent_duration_ms: envelope?.duration_ms ?? envelope?.durationMs ?? null,
    },
  };
}

// One formatting-only repair keeps a malformed JSON envelope from losing the
// diagnosis, without re-running the analysis or loosening its schema.
async function parseAnalysisJson(raw, repair) {
  try {
    return parseModelJson(raw, 'E2E Failure Analysis Agent');
  } catch (error) {
    if (!repair) throw error;
    return parseModelJsonWithRepair(raw, async (prior) => {
      const envelope = await repair(prior);
      return envelope;
    });
  }
}

export async function runE2eFailureAnalysis({
  request, workspace, outFile, telemetryFile = null,
  runModel = null, now = () => new Date(),
}) {
  if (!request || typeof request !== 'object') throw new Error('dispatch request is required');
  const prompt = renderE2eFailureAnalysisPrompt(request);
  const model = runModel
    ? (process.env.ANALYSIS_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'injected-model')
    : requestedGatewayModel();
  const startedAt = now();
  const invoke = runModel ?? (async (promptText) => {
    if (!process.env.ANTHROPIC_BASE_URL) throw new Error('ANTHROPIC_BASE_URL is required');
    if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required');
    }
    const { proc, parsed } = runClaudeCli({
      prompt: promptText, model, maxTurns: MAX_TURNS,
      allowedTools: ALLOWED_TOOLS, disallowedTools: DISALLOWED_TOOLS, cwd: workspace,
    });
    if (!parsed) throw new Error('Claude Code failed without a parseable response');
    if (proc.status !== 0) {
      const error = new Error('Claude Code exited ' + proc.status + ': ' +
        [proc.stderr?.trim(), parsed.result].filter(Boolean).join('\n'));
      error.envelope = parsed;
      throw error;
    }
    return parsed;
  });
  let envelope;
  try {
    envelope = await invoke(prompt.text);
  } catch (error) {
    if (telemetryFile) {
      writeAnalysisTelemetry(telemetryFile, request, prompt,
        providerMeta(model, error?.envelope, 'error', startedAt), { status: 'agent-error' });
    }
    throw error;
  }
  const parsed = await parseAnalysisJson(envelope.result, async (prior) => {
    const repaired = await runClaudeCli({
      prompt: [
        'FORMAT REPAIR ONLY. Do not change any diagnosis, add evidence, or invent a cause.',
        'Convert the prior output into one valid JSON object with the documented diagnosis shape.',
        'Prior output:',
        prior,
      ].join('\n'),
      model, maxTurns: '2', allowedTools: '', disallowedTools: DISALLOWED_TOOLS, cwd: workspace,
    });
    if (repaired.proc.status !== 0 || !repaired.parsed) {
      throw new Error('format repair failed');
    }
    return repaired.parsed.result;
  });
  const diagnosis = e2eFailureAnalysisResult(request, JSON.stringify(parsed));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(diagnosis, null, 2) + '\n');
  if (telemetryFile) {
    writeAnalysisTelemetry(telemetryFile, request, prompt,
      providerMeta(model, envelope, 'finished', startedAt), { status: 'completed' });
  }
  return diagnosis;
}

function writeAnalysisTelemetry(file, request, prompt, meta, result) {
  const summary = buildAgentWorkflowTelemetry({
    workflow_id: WORKFLOW_ID,
    github_workflow: process.env.GITHUB_WORKFLOW || 'Agent / E2E Failure Analysis',
    unique_run_name: providerScopedRunName({
      workflowId: WORKFLOW_ID,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      taskId: 'analysis-' + String(request.fingerprint).slice(5, 17),
      provider: meta.provider,
    }),
    job: 'analyze',
    task: {
      id: 'analysis-' + String(request.fingerprint).slice(5, 17),
      type: 'e2e-failure-analysis',
      issue: null,
      target_ref: request.source?.target_sha,
      fingerprint: request.fingerprint,
    },
    agent: {
      provider: meta.provider,
      id: 'e2e-failure-analysis-' + meta.provider,
      role: 'analyst',
      prompt: promptTelemetry(prompt),
      model: meta.model,
      run_id: meta.run_id,
      request_id: meta.request_id,
      status: meta.status,
    },
    execution: {
      turns: meta.turns, model_requests: meta.model_requests,
      tool_calls: meta.tool_calls, tools_observed: meta.tools_observed,
    },
    tokens: meta.tokens,
    cost: meta.cost,
    timing: meta.timing,
    result,
  });
  writeAgentWorkflowTelemetry(file, summary);
  const coverage = { model: 'unobserved', tools: 'unobserved', skills: 'unobserved', mcp: 'unobserved' };
  const trace = normalizeNativeTrace('claude-code', meta.native_events ?? [], summary, coverage);
  writeExecutionTrace(path.join(path.dirname(file), 'agent-execution-trace.json'), trace);
}

function selfTest() {
  const request = {
    source: { repository: 'BestNathan/nession', workflow_name: 'E2E / Full Regression',
      run_id: 40170599831, run_attempt: 1, target_sha: '1'.repeat(40),
      environment_id: 'main', completed_at: '2026-10-25T06:51:28Z' },
    fingerprint: 'e2e1:' + 'a'.repeat(64),
    failed_tests: [{ id: 'terminal-attach', kind: 'assertion_failed' }],
    evidence: [{ type: 'log', ref: 'playwright-report#terminal-attach',
      excerpt: 'Expected buffer 42, received 41' }],
    candidate_issues: [],
  };
  const workspace = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'e2e-analysis-'));
  const outFile = path.join(workspace, 'diagnosis.json');
  const modelResult = JSON.stringify({
    failure_category: 'product_regression',
    failed_test_ids: ['terminal-attach'],
    expected: 'buffer equals 42', actual: 'buffer equals 41',
    evidence: [{ type: 'log', ref: 'playwright-report#terminal-attach', note: 'assertion' }],
    suspected_locations: [{ path: 'web/src/terminal/Terminal.tsx', line: 120, reason: 'render path' }],
    causal_hypothesis: { summary: 'render truncates the final line', confidence: 'medium', status: 'hypothesis' },
    reproducible_steps: ['attach once'],
    proposed_regression_test: null,
    candidate_issues: [],
    unknowns: [],
  });
  const seen = [];
  const withModel = (result) => async () => {
    seen.push(result);
    return { session_id: 'fixture', num_turns: 1, usage: { input_tokens: 2, output_tokens: 1 }, result };
  };
  // The runner must pass a restricted, read-only prompt and accept a valid diagnosis.
  return (async () => {
    const diagnosis = await runE2eFailureAnalysis({
      request, workspace, outFile, runModel: withModel(modelResult),
    });
    assert.equal(diagnosis.source_run_id, 40170599831);
    assert.equal(diagnosis.fingerprint, request.fingerprint);
    assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).failure_category, 'product_regression');
    assert.equal(seen.length, 1);
    // A second call must fail closed when the model returns a schema-invalid
    // diagnosis instead of writing it to disk.
    const bad = JSON.stringify({ failure_category: 'regression' });
    await assert.rejects(() => runE2eFailureAnalysis({
      request, workspace, outFile: path.join(workspace, 'bad.json'), runModel: withModel(bad),
    }), /unexpected diagnosis fields|invalid failure category/);
    assert.equal(fs.existsSync(path.join(workspace, 'bad.json')), false);
    fs.rmSync(workspace, { recursive: true, force: true });
    console.log('e2e failure analysis runner self-test: passed');
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const command = process.argv[2];
  if (command === 'self-test') {
    await selfTest();
  } else if (command === 'run') {
    const [requestFile, workspace, outFile, telemetryFile] = process.argv.slice(3);
    if (!requestFile || !workspace || !outFile) {
      throw new Error('usage: e2e-failure-analysis-agent.mjs run REQUEST WORKSPACE OUT [TELEMETRY]');
    }
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    const diagnosis = await runE2eFailureAnalysis({ request, workspace, outFile, telemetryFile });
    process.stdout.write(JSON.stringify({
      fingerprint: diagnosis.fingerprint,
      failure_category: diagnosis.failure_category,
      failed_test_ids: diagnosis.failed_test_ids,
    }) + '\n');
  } else {
    throw new Error('usage: self-test | run REQUEST WORKSPACE OUT [TELEMETRY]');
  }
}
