#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const AGENT_SIGNALS = [
  /NSESSION_AGENT_WORKFLOW_ID:/,
  /CURSOR_API_KEY:/,
  /@cursor\/sdk/,
  /@anthropic-ai\/claude-code/,
  /\bclaude\s+--version\b/,
];


const TRUSTED_TELEMETRY_SOURCES = new Map([
  ['.github/workflows/acceptance.yml', {
    workflow_id: 'requirement-acceptance',
    events: new Set(['workflow_dispatch']),
    workflow_dispatch_main_only: true,
  }],
  ['.github/workflows/requirement-acceptance.yml', {
    workflow_id: 'requirement-acceptance',
    events: new Set(['pull_request_target', 'issues']),
    workflow_dispatch_main_only: false,
  }],
  ['.github/workflows/issue-audit.yml', {
    workflow_id: 'issue-audit',
    events: new Set(['issues', 'workflow_dispatch']),
    workflow_dispatch_main_only: true,
  }],
  ['.github/workflows/agent-provider-smoke.yml', {
    workflow_id: 'agent-provider-smoke',
    events: new Set(['push', 'workflow_dispatch']),
    workflow_dispatch_main_only: true,
  }],
]);

export function validateTelemetrySourceRun(run, repository = process.env.GITHUB_REPOSITORY) {
  const path = String(run?.path ?? '');
  const event = String(run?.event ?? '');
  const headBranch = String(run?.head_branch ?? '');
  const sourceRepository = String(run?.repository?.full_name ?? repository ?? '');
  const source = TRUSTED_TELEMETRY_SOURCES.get(path);

  if (!source) throw new Error('untrusted telemetry source workflow: ' + path);
  if (!source.events.has(event)) {
    throw new Error('untrusted telemetry source event for ' + path + ': ' + event);
  }
  if (repository && sourceRepository !== repository) {
    throw new Error('telemetry source repository mismatch: ' + sourceRepository + ' != ' + repository);
  }
  if (source.workflow_dispatch_main_only && (event === 'workflow_dispatch' || event === 'push') && headBranch !== 'main') {
    throw new Error('workflow_dispatch telemetry is trusted only from main: ' + path + ' @ ' + headBranch);
  }

  return {
    workflow_id: source.workflow_id,
    path,
    event,
    head_branch: headBranch || null,
    github_run_id: Number(run?.id ?? 0),
    github_run_attempt: Number(run?.run_attempt ?? 0),
  };
}

function workflowName(text, file) {
  const match = text.match(/^name:\s*([^#\n]+?)\s*$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : basename(file);
}

function workflowId(text) {
  const match = text.match(/NSESSION_AGENT_WORKFLOW_ID:\s*['"]?([a-z0-9][a-z0-9._-]*)['"]?/);
  return match?.[1] ?? null;
}

function referencedReusableWorkflows(text) {
  return [...text.matchAll(/uses:\s*\.\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g)]
    .map((match) => match[1]);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

export function auditAgentWorkflowTelemetry(files, ingestText) {
  const entries = Object.entries(files).map(([file, text]) => ({
    file,
    text,
    name: workflowName(text, file),
    id: workflowId(text),
    directAgent: AGENT_SIGNALS.some((signal) => signal.test(text)),
    refs: referencedReusableWorkflows(text),
  }));
  const directFiles = new Set(entries.filter((entry) => entry.directAgent).map((entry) => basename(entry.file)));
  const sourceEntries = entries.filter((entry) =>
    entry.directAgent || entry.refs.some((ref) => directFiles.has(ref)),
  );
  const errors = [];

  for (const entry of entries.filter((candidate) => candidate.directAgent)) {
    if (!entry.id) {
      errors.push(entry.file + ': Agent workflow must declare NSESSION_AGENT_WORKFLOW_ID');
    }
    if (!/agent-telemetry-/.test(entry.text)) {
      errors.push(entry.file + ': Agent workflow must upload an artifact whose name starts with agent-telemetry-');
    }
  }

  for (const entry of sourceEntries) {
    const escaped = escapeRegex(entry.name);
    const listed = new RegExp('(?:^|\\n)\\s*-\\s*["\\\']?' + escaped + '["\\\']?\\s*(?:#.*)?(?:\\n|$)').test(ingestText);
    if (!listed) {
      errors.push('metrics ingest does not observe workflow: ' + entry.name + ' (' + entry.file + ')');
    }
  }

  const seen = new Map();
  for (const entry of entries.filter((candidate) => candidate.directAgent && candidate.id)) {
    if (seen.has(entry.id)) {
      errors.push('duplicate NSESSION_AGENT_WORKFLOW_ID ' + entry.id + ': ' + seen.get(entry.id) + ', ' + entry.file);
    } else {
      seen.set(entry.id, entry.file);
    }
  }

  return { ok: errors.length === 0, errors, agent_workflows: sourceEntries.map((entry) => entry.name) };
}

function loadWorkflows(dir) {
  const files = {};
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    files[name] = readFileSync(join(dir, name), 'utf8');
  }
  return files;
}

function checkRepository() {
  const dir = '.github/workflows';
  const ingest = join(dir, 'metrics-ingest.yml');
  if (!existsSync(ingest)) {
    throw new Error('metrics-ingest.yml is required for Agent workflow telemetry persistence');
  }
  const audit = auditAgentWorkflowTelemetry(loadWorkflows(dir), readFileSync(ingest, 'utf8'));
  if (!audit.ok) {
    for (const error of audit.errors) console.error('✗ ' + error);
    console.error('Fix: load nession-agent-workflow-metrics and connect every Agent workflow to canonical telemetry.');
    process.exitCode = 1;
    return;
  }
  console.log('agent workflow telemetry contract: ' + audit.agent_workflows.length + ' workflow source(s) covered');
}

function selfTest() {
  const files = {
    'agent.yml': [
      'name: Example Agent',
      'env:',
      '  NSESSION_AGENT_WORKFLOW_ID: example-agent',
      'jobs:',
      '  run:',
      '    steps:',
      '      - run: npm install @cursor/sdk',
      '      - uses: actions/upload-artifact@v4',
      '        with:',
      '          name: agent-telemetry-example',
    ].join('\n'),
    'caller.yml': [
      'name: Example Caller',
      'jobs:',
      '  agent:',
      '    uses: ./.github/workflows/agent.yml',
    ].join('\n'),
  };
  const ingest = [
    'workflows:',
    '  - Example Agent',
    '  - Example Caller',
  ].join('\n');
  assert.equal(auditAgentWorkflowTelemetry(files, ingest).ok, true);

  const missingArtifact = {
    'agent.yml': 'name: Bad Agent\nenv:\n  NSESSION_AGENT_WORKFLOW_ID: bad\njobs:\n  x:\n    steps:\n      - run: echo missing artifact\n',
  };
  assert.match(auditAgentWorkflowTelemetry(missingArtifact, 'workflows:\n  - Bad Agent\n').errors.join('\n'), /agent-telemetry/);

  const missingIngest = auditAgentWorkflowTelemetry(files, 'workflows:\n  - Example Agent\n');
  assert.match(missingIngest.errors.join('\n'), /Example Caller/);

  assert.equal(validateTelemetrySourceRun({
    id: 10,
    run_attempt: 2,
    path: '.github/workflows/requirement-acceptance.yml',
    event: 'pull_request_target',
    head_branch: 'feature',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession').workflow_id, 'requirement-acceptance');

  assert.equal(validateTelemetrySourceRun({
    id: 11,
    run_attempt: 1,
    path: '.github/workflows/issue-audit.yml',
    event: 'issues',
    head_branch: 'main',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession').workflow_id, 'issue-audit');

  assert.throws(() => validateTelemetrySourceRun({
    id: 12,
    run_attempt: 1,
    path: '.github/workflows/issue-audit.yml',
    event: 'workflow_dispatch',
    head_branch: 'feature',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession'), /trusted only from main/);

  assert.throws(() => validateTelemetrySourceRun({
    id: 13,
    run_attempt: 1,
    path: '.github/workflows/fake-agent.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession'), /untrusted telemetry source workflow/);

  assert.equal(validateTelemetrySourceRun({
    id: 14, run_attempt: 1,
    path: '.github/workflows/agent-provider-smoke.yml',
    event: 'push', head_branch: 'main',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession').workflow_id, 'agent-provider-smoke');

  assert.throws(() => validateTelemetrySourceRun({
    id: 15, run_attempt: 1,
    path: '.github/workflows/agent-provider-smoke.yml',
    event: 'push', head_branch: 'feature',
    repository: { full_name: 'BestNathan/nession' },
  }, 'BestNathan/nession'), /trusted only from main/);

  console.log('agent-workflow-telemetry-contract self-test: 9 cases passed');
}

const command = process.argv[2] ?? 'check';
if (command === 'self-test' || command === '--self-test') selfTest();
else if (command === 'check') checkRepository();
else if (command === 'provenance') {
  const file = process.argv[3];
  if (!file) throw new Error('usage: agent-workflow-telemetry-contract.mjs provenance RUN_JSON');
  const result = validateTelemetrySourceRun(JSON.parse(readFileSync(file, 'utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  throw new Error('usage: agent-workflow-telemetry-contract.mjs <check|self-test|provenance RUN_JSON>');
}
