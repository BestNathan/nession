#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export const AGENT_TELEMETRY_SCHEMA_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nullableInteger(value) {
  const number = nullableNumber(value);
  return number != null && Number.isInteger(number) && number >= 0 ? number : null;
}

function stableId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(text)) {
    fail(label + ' must be a stable lowercase id: ' + text);
  }
  return text;
}

function iso(value, fallback = null) {
  const candidate = value ?? fallback;
  if (candidate == null) return null;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) fail('invalid ISO timestamp: ' + candidate);
  return date.toISOString();
}

function normalizeTokens(tokens = {}) {
  const normalized = {
    input: nullableInteger(tokens.input ?? tokens.input_tokens),
    output: nullableInteger(tokens.output ?? tokens.output_tokens),
    cache_read: nullableInteger(tokens.cache_read ?? tokens.cache_read_tokens),
    cache_write: nullableInteger(tokens.cache_write ?? tokens.cache_write_tokens),
    reasoning: nullableInteger(tokens.reasoning ?? tokens.reasoning_tokens),
    total: nullableInteger(tokens.total ?? tokens.total_tokens),
  };
  if (normalized.total == null) {
    const known = ['input', 'output', 'cache_read', 'cache_write', 'reasoning']
      .map((key) => normalized[key])
      .filter((value) => value != null);
    if (known.length) normalized.total = known.reduce((sum, value) => sum + value, 0);
  }
  return normalized;
}

export function summarizeToolCalls(toolCalls, observed = true) {
  if (!observed) {
    return { observed: false, total: null, unique: null, by_name: null };
  }
  const byName = {};
  for (const raw of toolCalls ?? []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    byName[name] = (byName[name] ?? 0) + 1;
  }
  return {
    observed: true,
    total: Object.values(byName).reduce((sum, value) => sum + value, 0),
    unique: Object.keys(byName).length,
    by_name: Object.fromEntries(Object.entries(byName).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function buildAgentWorkflowTelemetry(input) {
  const workflowId = stableId(input.workflow_id, 'workflow_id');
  const runId = nullableInteger(input.github_run_id ?? process.env.GITHUB_RUN_ID);
  const runAttempt = nullableInteger(input.github_run_attempt ?? process.env.GITHUB_RUN_ATTEMPT);
  if (!runId || !runAttempt) fail('github run id and run attempt are required');

  const task = { ...(input.task ?? {}) };
  task.id = stableId(task.id, 'task.id');
  task.type = stableId(task.type, 'task.type');

  const uniqueRunName = stableId(
    input.unique_run_name ?? String(runId) + '-' + String(runAttempt) + '-' + task.id,
    'unique_run_name',
  );

  const startedAt = iso(input.timing?.started_at, new Date().toISOString());
  const finishedAt = iso(input.timing?.finished_at);
  const tools = input.execution?.tools?.observed != null
    ? input.execution.tools
    : summarizeToolCalls(input.execution?.tool_calls, input.execution?.tools_observed !== false);

  const record = {
    schema_version: AGENT_TELEMETRY_SCHEMA_VERSION,
    kind: 'agent_workflow_run',
    identity: {
      workflow_id: workflowId,
      github_workflow: String(input.github_workflow ?? process.env.GITHUB_WORKFLOW ?? workflowId),
      github_run_id: runId,
      github_run_attempt: runAttempt,
      job: input.job == null ? null : String(input.job),
      repository: String(input.repository ?? process.env.GITHUB_REPOSITORY ?? ''),
      event: String(input.event ?? process.env.GITHUB_EVENT_NAME ?? ''),
      unique_run_name: uniqueRunName,
    },
    task,
    agent: {
      provider: String(input.agent?.provider ?? 'unknown'),
      model: input.agent?.model ?? null,
      run_id: input.agent?.run_id ?? null,
      request_id: input.agent?.request_id ?? null,
      status: String(input.agent?.status ?? 'unknown'),
      prompt: input.agent?.prompt ?? null,
    },
    execution: {
      turns: nullableInteger(input.execution?.turns),
      model_requests: nullableInteger(input.execution?.model_requests),
      tools: {
        observed: Boolean(tools?.observed),
        total: nullableInteger(tools?.total),
        unique: nullableInteger(tools?.unique),
        by_name: tools?.by_name ?? null,
      },
    },
    tokens: normalizeTokens(input.tokens),
    cost: {
      raw_usd: nullableNumber(input.cost?.raw_usd),
      charged_usd: nullableNumber(input.cost?.charged_usd),
      estimated_usd: nullableNumber(input.cost?.estimated_usd),
    },
    timing: {
      started_at: startedAt,
      finished_at: finishedAt,
      agent_duration_ms: nullableInteger(input.timing?.agent_duration_ms),
      workflow_duration_ms: nullableInteger(input.timing?.workflow_duration_ms),
    },
    result: input.result ?? { status: 'unknown' },
  };

  validateAgentWorkflowTelemetry(record);
  return record;
}

export function validateAgentWorkflowTelemetry(record) {
  if (record?.schema_version !== AGENT_TELEMETRY_SCHEMA_VERSION) {
    fail('unsupported agent telemetry schema_version: ' + record?.schema_version);
  }
  if (record?.kind !== 'agent_workflow_run') fail('kind must be agent_workflow_run');
  stableId(record?.identity?.workflow_id, 'identity.workflow_id');
  stableId(record?.identity?.unique_run_name, 'identity.unique_run_name');
  if (!Number.isInteger(record?.identity?.github_run_id) || record.identity.github_run_id <= 0) {
    fail('identity.github_run_id must be a positive integer');
  }
  if (!Number.isInteger(record?.identity?.github_run_attempt) || record.identity.github_run_attempt <= 0) {
    fail('identity.github_run_attempt must be a positive integer');
  }
  stableId(record?.task?.id, 'task.id');
  stableId(record?.task?.type, 'task.type');
  if (record.agent.prompt != null) {
    const prompt = record.agent.prompt;
    if (!/^[a-z][a-z0-9-]*$/.test(prompt.id) || !/^v[1-9][0-9]*$/.test(prompt.version) ||
        !/^[0-9a-f]{64}$/.test(prompt.sha256)) {
      fail('invalid agent prompt template identity/hash');
    }
  }
  iso(record?.timing?.started_at);
  if (record?.timing?.finished_at != null) iso(record.timing.finished_at);
  if (typeof record?.execution?.tools?.observed !== 'boolean') {
    fail('execution.tools.observed must be boolean');
  }
  if (record.execution.tools.observed) {
    if (!Number.isInteger(record.execution.tools.total) || record.execution.tools.total < 0) {
      fail('observed tool telemetry requires a non-negative total');
    }
    if (!record.execution.tools.by_name || typeof record.execution.tools.by_name !== 'object') {
      fail('observed tool telemetry requires by_name');
    }
  } else if (
    record.execution.tools.total != null ||
    record.execution.tools.unique != null ||
    record.execution.tools.by_name != null
  ) {
    fail('unobserved tool telemetry must use null counts');
  }
  return record;
}

export function telemetryStoragePath(record) {
  validateAgentWorkflowTelemetry(record);
  const date = record.timing.started_at.slice(0, 10);
  return [
    'raw',
    'workflows',
    record.identity.workflow_id,
    date,
    record.identity.unique_run_name + '.json',
  ].join('/');
}

export function writeAgentWorkflowTelemetry(file, input) {
  const record = input?.kind === 'agent_workflow_run' ? input : buildAgentWorkflowTelemetry(input);
  validateAgentWorkflowTelemetry(record);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return record;
}

function walkJson(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJson(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function numericStats(records, getter) {
  const values = records.map(getter).filter((value) => Number.isFinite(value));
  return {
    observed_runs: values.length,
    total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
  };
}

function sumNullable(records, getter) {
  const values = records.map(getter).filter((value) => Number.isFinite(value));
  return {
    observed_runs: values.length,
    total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
  };
}

function countBy(records, getter) {
  const result = {};
  for (const record of records) {
    const key = getter(record);
    if (!key) continue;
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function aggregateWindow(records) {
  const toolObserved = records.filter((record) => record.execution.tools.observed);
  const toolByName = {};
  for (const record of toolObserved) {
    for (const [name, count] of Object.entries(record.execution.tools.by_name ?? {})) {
      toolByName[name] = (toolByName[name] ?? 0) + Number(count);
    }
  }

  return {
    runs: {
      total: records.length,
      by_workflow: countBy(records, (record) => record.identity.workflow_id),
      by_provider: countBy(records, (record) => record.agent.provider),
      by_result: countBy(records, (record) => record.result?.status),
    },
    turns: numericStats(records, (record) => record.execution.turns),
    model_requests: numericStats(records, (record) => record.execution.model_requests),
    tools: {
      ...numericStats(toolObserved, (record) => record.execution.tools.total),
      by_name: Object.fromEntries(Object.entries(toolByName).sort(([, a], [, b]) => b - a)),
    },
    tokens: {
      input: sumNullable(records, (record) => record.tokens.input),
      output: sumNullable(records, (record) => record.tokens.output),
      cache_read: sumNullable(records, (record) => record.tokens.cache_read),
      cache_write: sumNullable(records, (record) => record.tokens.cache_write),
      reasoning: sumNullable(records, (record) => record.tokens.reasoning),
      total: sumNullable(records, (record) => record.tokens.total),
    },
    duration_ms: numericStats(records, (record) => record.timing.agent_duration_ms),
    cost_usd: {
      raw: sumNullable(records, (record) => record.cost.raw_usd),
      charged: sumNullable(records, (record) => record.cost.charged_usd),
      estimated: sumNullable(records, (record) => record.cost.estimated_usd),
    },
  };
}

export function aggregateAgentWorkflowTelemetry(records, now = new Date()) {
  const nowMs = now.getTime();
  const within = (days) => records.filter((record) => {
    const started = Date.parse(record.timing.started_at);
    return started <= nowMs && started >= nowMs - days * 24 * 60 * 60 * 1000;
  });
  return {
    schema_version: 1,
    kind: 'agent_metrics_aggregate',
    generated_at: now.toISOString(),
    windows: {
      '7d': aggregateWindow(within(7)),
      '30d': aggregateWindow(within(30)),
      all_time: aggregateWindow(records),
    },
  };
}

function compactNumber(value) {
  if (value == null) return 'N/A';
  if (Math.abs(value) >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(value) >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(value));
}

function duration(value) {
  if (value == null) return 'N/A';
  if (value >= 60_000) return (value / 60_000).toFixed(1) + 'm';
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 's';
  return Math.round(value) + 'ms';
}

function usd(value) {
  return value == null ? 'N/A' : '$' + Number(value).toFixed(value < 1 ? 3 : 2);
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function topTools(window) {
  return Object.entries(window.tools.by_name ?? {}).slice(0, 3)
    .map(([name, count]) => name + ' ' + count)
    .join(' · ') || 'no observed tool calls';
}

export function renderAgentMetricsSvg(metrics, theme) {
  const dark = theme === 'dark';
  const palette = dark
    ? { bg: '#0d1117', card: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#8b949e', accent: '#58a6ff' }
    : { bg: '#ffffff', card: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#656d76', accent: '#0969da' };
  const seven = metrics.windows['7d'];
  const thirty = metrics.windows['30d'];
  const cards = [
    ['Runs', seven.runs.total + ' / ' + thirty.runs.total, '7d / 30d'],
    ['Avg turns', compactNumber(seven.turns.avg) + ' / ' + compactNumber(thirty.turns.avg), '7d / 30d'],
    ['Tool calls', compactNumber(seven.tools.total) + ' / ' + compactNumber(thirty.tools.total), topTools(thirty)],
    ['Tokens', compactNumber(seven.tokens.total.total) + ' / ' + compactNumber(thirty.tokens.total.total), '7d / 30d total'],
    ['Agent duration', duration(seven.duration_ms.avg) + ' / ' + duration(thirty.duration_ms.avg), '7d / 30d average'],
    ['Charged cost', usd(seven.cost_usd.charged.total) + ' / ' + usd(thirty.cost_usd.charged.total), '7d / 30d'],
  ];
  const width = 1180;
  const margin = 16;
  const gap = 10;
  const cardWidth = (width - margin * 2 - gap * 5) / 6;
  const cardY = 66;
  const cardHeight = 78;
  const body = cards.map((card, index) => {
    const x = margin + index * (cardWidth + gap);
    return '<g><rect x="' + x + '" y="' + cardY + '" width="' + cardWidth + '" height="' + cardHeight + '" rx="10" fill="' + palette.card + '" stroke="' + palette.border + '"/>' +
      '<text x="' + (x + 12) + '" y="' + (cardY + 20) + '" class="label">' + xml(card[0]) + '</text>' +
      '<text x="' + (x + 12) + '" y="' + (cardY + 47) + '" class="primary">' + xml(card[1]) + '</text>' +
      '<text x="' + (x + 12) + '" y="' + (cardY + 67) + '" class="secondary">' + xml(card[2]) + '</text></g>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="160" viewBox="0 0 1180 160" role="img" aria-labelledby="title desc">' +
    '<title id="title">Nession Agent Workflow Telemetry</title>' +
    '<desc id="desc">Rolling seven-day and thirty-day agent workflow runs, turns, tool calls, token consumption, duration and cost.</desc>' +
    '<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}.heading{font-size:18px;font-weight:650;fill:' + palette.text + '}.meta,.label,.secondary{fill:' + palette.muted + '}.meta,.label{font-size:11px}.label{font-weight:600}.primary{font-size:17px;font-weight:700;fill:' + palette.accent + '}.secondary{font-size:9px}</style>' +
    '<rect width="1180" height="160" rx="14" fill="' + palette.bg + '" stroke="' + palette.border + '"/>' +
    '<text x="16" y="28" class="heading">Agent Workflow Telemetry</text>' +
    '<text x="1164" y="28" text-anchor="end" class="meta">7d / 30d · updated ' + xml(metrics.generated_at.replace('.000Z', 'Z')) + '</text>' +
    body +
    '</svg>\n';
}

function readRecord(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  return validateAgentWorkflowTelemetry(record);
}

function aggregateCommand(rawDir, outputDir) {
  const records = walkJson(rawDir).map(readRecord);
  const now = process.env.METRICS_NOW ? new Date(process.env.METRICS_NOW) : new Date();
  if (Number.isNaN(now.getTime())) fail('METRICS_NOW must be ISO-8601');
  const metrics = aggregateAgentWorkflowTelemetry(records, now);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'agent-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  writeFileSync(join(outputDir, 'agent-metrics-light.svg'), renderAgentMetricsSvg(metrics, 'light'));
  writeFileSync(join(outputDir, 'agent-metrics-dark.svg'), renderAgentMetricsSvg(metrics, 'dark'));
  console.log('agent telemetry: ' + records.length + ' raw run(s) -> ' + outputDir);
}

function selfTest() {
  const fixture = buildAgentWorkflowTelemetry({
    workflow_id: 'requirement-acceptance',
    github_run_id: 123,
    github_run_attempt: 2,
    github_workflow: 'Requirement Acceptance',
    job: 'execute',
    repository: 'BestNathan/nession',
    event: 'pull_request_target',
    task: { id: 'issue-1458-pre-merge', type: 'acceptance', issue: 1458, stage: 'pre-merge' },
    agent: { provider: 'cursor', model: { id: 'composer-2.5' }, status: 'finished',
      prompt: { id: 'issue-audit', version: 'v1', sha256: 'a'.repeat(64) } },
    execution: { turns: 3, model_requests: 3, tool_calls: ['read', 'grep', 'read'], tools_observed: true },
    tokens: { input: 10, output: 5, cache_read: 20, cache_write: 0 },
    cost: { charged_usd: 0.01 },
    timing: { started_at: '2026-10-07T03:20:12Z', finished_at: '2026-10-07T03:20:13Z', agent_duration_ms: 1000 },
    result: { status: 'completed' },
  });
  assert.equal(telemetryStoragePath(fixture), 'raw/workflows/requirement-acceptance/2026-10-07/123-2-issue-1458-pre-merge.json');
  assert.deepEqual(fixture.execution.tools.by_name, { grep: 1, read: 2 });
  assert.equal(fixture.tokens.total, 35);
  assert.equal(fixture.agent.prompt.sha256, 'a'.repeat(64));
  assert.throws(() => validateAgentWorkflowTelemetry({ ...fixture, agent: { ...fixture.agent, prompt: { ...fixture.agent.prompt, sha256: 'broken' } } }), /invalid agent prompt/);
  const metrics = aggregateAgentWorkflowTelemetry([fixture], new Date('2026-10-08T00:00:00Z'));
  assert.equal(metrics.windows['7d'].runs.total, 1);
  assert.equal(metrics.windows['30d'].tools.total, 3);
  assert.match(renderAgentMetricsSvg(metrics, 'dark'), /Agent Workflow Telemetry/);
  console.log('agent-workflow-telemetry self-test: 6 cases passed');
}

async function main() {
  const command = process.argv[2];
  if (command === '--self-test' || command === 'self-test') return selfTest();
  if (command === 'validate') {
    const record = readRecord(process.argv[3]);
    console.log(telemetryStoragePath(record));
    return;
  }
  if (command === 'path') {
    console.log(telemetryStoragePath(readRecord(process.argv[3])));
    return;
  }
  if (command === 'aggregate') {
    const rawDir = resolve(process.argv[3] || 'raw/workflows');
    const outputDir = resolve(process.argv[4] || '.agent-metrics');
    aggregateCommand(rawDir, outputDir);
    return;
  }
  fail('usage: agent-workflow-telemetry.mjs <self-test|validate FILE|path FILE|aggregate RAW_DIR OUT_DIR>');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    await main();
  } catch (error) {
    console.error('agent-workflow-telemetry: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
