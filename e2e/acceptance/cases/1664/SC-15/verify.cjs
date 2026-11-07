'use strict';
// #1664 SC-15: real completed Agent artifacts are authenticated by the
// canonical Metrics Ingest and persisted once per source run/attempt on the
// metrics orphan branch. Spoofed workflow identity, unsafe fields and
// conflicting replay are rejected by the executable ingest fixtures.
const {
  assert, targetSha, runNode, requireSummary, api, assertAncestor, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

const RUN_ID = 42361329905;
const RUN_ATTEMPT = 1;
const SOURCE_SHA = 'eb3ed31ac8cdb70684b5d7e3c3b3d36e4532fc40';
const RECORD = '42361329905-1-issue-1664-dev-qwen-canary-claude-code';

async function main() {
  const target = targetSha();
  const ingest = runNode('scripts/agent-telemetry-ingest.mjs', ['self-test']);
  requireSummary(ingest,
    'Agent Metrics trusted immutable ingest + trace replay and negative fixtures passed',
    'canonical Metrics ingest');
  const race = runNode('scripts/agent-telemetry-reconcile-race-selftest.mjs');
  requireSummary(race,
    'Agent Metrics queue replacement + two stale Git writers: no force push, immutable CAS-style retry, replay and conflict fixtures passed',
    'Metrics reconcile race');
  const contract = runNode('scripts/agent-workflow-telemetry-contract.mjs');
  requireSummary(contract, 'agent workflow telemetry contract:', 'telemetry workflow contract');

  assertAncestor(SOURCE_SHA, target);
  const directory = await api('/contents/raw/workflows/agent-provider-smoke/2026-11-07?ref=metrics');
  assert.ok(Array.isArray(directory), 'metrics workflow directory is not a directory listing');
  const matches = directory.filter(entry => entry.name.startsWith(RECORD + '.json'));
  assert.equal(matches.length, 1, 'canonical Provider record is not persisted exactly once');
  const entry = await api('/contents/' + matches[0].path + '?ref=metrics');
  assert.equal(entry.encoding, 'base64');
  const doc = JSON.parse(Buffer.from(entry.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.kind, 'agent_workflow_run');
  assert.equal(doc.identity.workflow_id, 'agent-provider-smoke');
  assert.equal(doc.identity.github_workflow, 'Agent / Provider Smoke');
  assert.equal(doc.identity.github_run_id, RUN_ID);
  assert.equal(doc.identity.github_run_attempt, RUN_ATTEMPT);
  assert.equal(doc.identity.job, 'qwen-developer-canary');
  assert.equal(doc.identity.repository, 'BestNathan/nession');
  assert.equal(doc.identity.event, 'push');
  assert.equal(doc.task.issue, 1664);
  assert.equal(doc.task.target_ref, SOURCE_SHA);
  assert.equal(doc.agent.id, 'dev-qwen-01');
  assert.equal(doc.agent.role, 'developer');
  assert.equal(doc.agent.provider, 'claude-code');
  assert.equal(doc.execution?.tools?.by_name?.Read, 1);
  assert.equal(doc.execution?.tools?.by_name?.Edit, 1);
  assert.equal(doc.result?.status, 'canary-pass');
  assert.doesNotMatch(JSON.stringify(doc),
    /ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|CURSOR_API_KEY|BEGIN PRIVATE KEY/);

  pass(
    'Canonical Metrics Ingest authenticates real Agent artifacts; the exact Provider Smoke record is persisted once at its source run/attempt and contains only bounded sanitized telemetry; spoof/replay fixtures fail closed.',
    [
      { type: 'runtime', value: 'agent-telemetry-ingest self-test: trusted immutable ingest + trace replay and negative fixtures' },
      { type: 'runtime', value: 'agent-telemetry-reconcile-race-selftest: no force push, immutable CAS retry, replay/conflict denial' },
      { type: 'store', value: 'metrics ' + matches[0].path + ' is the single record for run ' + RUN_ID + '/' + RUN_ATTEMPT + '; run id/attempt/workflow/job/issue/SHA/agent/tool telemetry/result verified; no secret fields' },
      { type: 'source', value: 'telemetry contract covers the checked-in Agent workflows; source SHA ' + SOURCE_SHA + ' is an ancestor of target ' + target },
    ],
  );
}

main().catch(fail);
