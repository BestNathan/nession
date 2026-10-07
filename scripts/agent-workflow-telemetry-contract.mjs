#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const AGENT_SIGNALS = [
  /CURSOR_API_KEY/,
  /@cursor\/sdk/,
  /@anthropic-ai\/claude-code/,
  /\bclaude\s+--version\b/,
  /acceptance-agent\.mjs/,
  /issue-audit-(?:agent|cursor)\.mjs/,
];

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
    'agent.yml': 'name: Bad Agent\nenv:\n  NSESSION_AGENT_WORKFLOW_ID: bad\njobs:\n  x:\n    steps:\n      - run: echo $CURSOR_API_KEY\n',
  };
  assert.match(auditAgentWorkflowTelemetry(missingArtifact, 'workflows:\n  - Bad Agent\n').errors.join('\n'), /agent-telemetry/);

  const missingIngest = auditAgentWorkflowTelemetry(files, 'workflows:\n  - Example Agent\n');
  assert.match(missingIngest.errors.join('\n'), /Example Caller/);
  console.log('agent-workflow-telemetry-contract self-test: 3 cases passed');
}

const command = process.argv[2] ?? 'check';
if (command === 'self-test' || command === '--self-test') selfTest();
else if (command === 'check') checkRepository();
else throw new Error('usage: agent-workflow-telemetry-contract.mjs <check|self-test>');
