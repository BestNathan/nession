#!/usr/bin/env node
// A real-provider, read-only Acceptance canary. No Issue/GitHub writes.
import assert from 'node:assert/strict';
import { providerScopedRunName } from './telemetry/run-name.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED = 'SC-99';

export function smokeContext(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Smoke target requires exact commit SHA');
  return {
    issue: { number: 1556, title: 'Synthetic provider smoke fixture (not a real requirement)' },
    stage: 'staging',
    target_ref: sha,
    deployment: null,
    ci_evidence: null,
    requirement_body: 'Synthetic fixture. No test, deployment, or CI evidence supports the following claim. This run must not update an Issue.',
    criteria: [{
      criterion: EXPECTED,
      stage: 'staging',
      text: 'An external service has independently proven successful deployment of the nonexistent synthetic service canary-example-000. Evidence is not supplied.',
    }],
  };
}

export function verifySmoke({ context, result, telemetry, provider }) {
  if (!['cursor', 'deepseek'].includes(provider)) throw new Error('Unexpected smoke provider');
  assert.equal(context.criteria.length, 1);
  assert.equal(context.criteria[0].criterion, EXPECTED);
  assert.equal(result.criteria?.length, 1, 'exactly one criterion must be returned');
  const answer = result.criteria[0];
  assert.equal(answer.criterion, EXPECTED, 'provider must not change criterion identity');
  assert.equal(answer.result, 'Pending', 'fabricated evidence must never become Pass/Fail/N/A');
  assert.equal(telemetry.schema_version, 1);
  assert.equal(telemetry.agent.provider, provider, 'telemetry provider must match selected provider');
  assert.equal(telemetry.agent.status, 'finished');
  assert.equal(telemetry.agent.prompt?.id, 'acceptance');
  assert.equal(telemetry.agent.prompt?.version, 'v1');
  assert.match(telemetry.agent.prompt?.sha256 || '', /^[0-9a-f]{64}$/, 'prompt sha256 must be valid');
  assert.equal(telemetry.task.target_ref, context.target_ref);
  const expectedSuffix = '-issue-' + context.issue.number + '-' + context.stage + '-' + provider;
  assert.ok(telemetry.identity?.unique_run_name?.endsWith(expectedSuffix),
    'immutable telemetry run name must be scoped by Provider to prevent matrix collisions');
  return { provider, outcome: 'Pending', template: telemetry.agent.prompt.id, template_version: telemetry.agent.prompt.version, prompt_sha256: telemetry.agent.prompt.sha256 };
}

export function selfTest() {
  const context = smokeContext('a'.repeat(40));
  const fixture = {
    context, provider: 'deepseek',
    result: { criteria: [{ criterion: EXPECTED, result: 'Pending', evidence: [], summary: 'No evidence supplied' }] },
    telemetry: { schema_version: 1, identity: { unique_run_name: '42-1-issue-1556-staging-deepseek' }, task: { target_ref: context.target_ref }, agent: {
      provider: 'deepseek', status: 'finished', prompt: { id: 'acceptance', version: 'v1', sha256: 'c'.repeat(64) },
    } },
  };
  assert.equal(verifySmoke(fixture).outcome, 'Pending');
  assert.throws(() => smokeContext('not-a-commit'), /exact commit/);
  assert.throws(() => verifySmoke({ ...fixture, provider: 'unknown' }), /Unexpected smoke provider/);
  assert.throws(() => verifySmoke({ ...fixture, result: { criteria: [] } }), /exactly one/);
  assert.throws(() => verifySmoke({ ...fixture, result: { criteria: [{ criterion: 'SC-98', result: 'Pending' }] } }), /criterion identity/);
  assert.throws(() => verifySmoke({ ...fixture, result: { criteria: [{ criterion: EXPECTED, result: 'Pass' }] } }), /fabricated evidence/);
  assert.throws(() => verifySmoke({ ...fixture, telemetry: { ...fixture.telemetry, agent: { ...fixture.telemetry.agent, provider: 'cursor' } } }), /provider/);
  assert.throws(() => verifySmoke({ ...fixture, telemetry: { ...fixture.telemetry, agent: { ...fixture.telemetry.agent, prompt: { id: 'acceptance', version: 'v1', sha256: 'invalid' } } } }), /sha256/);

  const nameCursor = providerScopedRunName({
    workflowId: 'agent-provider-smoke', runId: 42, runAttempt: 1,
    taskId: 'issue-1556-staging', provider: 'cursor',
  });
  const nameDeepSeek = providerScopedRunName({
    workflowId: 'agent-provider-smoke', runId: 42, runAttempt: 1,
    taskId: 'issue-1556-staging', provider: 'deepseek',
  });
  assert.notEqual(nameCursor, nameDeepSeek, 'concurrent provider jobs must not have identical immutable paths');
  assert.equal(providerScopedRunName({
    workflowId: 'requirement-acceptance', runId: 42, runAttempt: 1,
    taskId: 'issue-1556-staging', provider: 'cursor',
  }), undefined, 'non-smoke workflows must keep their existing run naming');
  assert.throws(() => providerScopedRunName({
    workflowId: 'agent-provider-smoke', runId: 42, runAttempt: 1,
    taskId: 'issue-1556-staging', provider: 'other',
  }), /declared Provider/);
  assert.throws(() => verifySmoke({
    ...fixture, telemetry: {
      ...fixture.telemetry, identity: { unique_run_name: nameCursor },
    },
  }), /matrix collisions/);
  console.log('AI Agent provider smoke self-test: 12 positive/negative cases passed');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'self-test') return selfTest();
  if (command === 'prepare') {
    const [filename, sha] = args;
    if (!filename) throw new Error('missing context output path');
    fs.writeFileSync(filename, JSON.stringify(smokeContext(sha), null, 2) + '\n');
    return;
  }
  if (command === 'verify') {
    const [contextFile, resultFile, telemetryFile, provider] = args;
    const value = verifySmoke({
      context: JSON.parse(fs.readFileSync(contextFile, 'utf8')),
      result: JSON.parse(fs.readFileSync(resultFile, 'utf8')),
      telemetry: JSON.parse(fs.readFileSync(telemetryFile, 'utf8')),
      provider,
    });
    console.log(JSON.stringify(value));
    return;
  }
  throw new Error('usage: provider-smoke.mjs <self-test|prepare PATH SHA|verify CONTEXT RESULT TELEMETRY PROVIDER>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
