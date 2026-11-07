'use strict';
// #2274 SC-02: a signed dev-qwen-01 dispatch from the canonical Outbox runs
// the real Qwen Claude Code Developer in the isolated Worker, produces a
// validated patch and exact-SHA canonical telemetry with no privileged creds.
const {
  assert, targetSha, verifyQwenRepairChain2961, rawMetrics, REPAIR_2961,
  pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const recordPath = 'raw/workflows/agent-develop/2026-11-07/' +
    REPAIR_2961.runs.developerA.id + '-1-' + REPAIR_2961.actions.init + '.json';
  const record = JSON.parse((await rawMetrics(recordPath)).toString('utf8'));
  assert.equal(record.kind, 'agent_workflow_run');
  assert.equal(record.identity.workflow_id, 'agent-develop');
  assert.equal(record.identity.github_workflow, 'Agent / Development');
  assert.equal(record.identity.github_run_id, REPAIR_2961.runs.developerA.id);
  assert.equal(record.identity.github_run_attempt, 1);
  assert.equal(record.identity.job, 'qwen-developer');
  assert.equal(record.identity.repository, 'BestNathan/nession');
  assert.equal(record.identity.event, 'workflow_dispatch');
  assert.equal(record.identity.unique_run_name,
    REPAIR_2961.runs.developerA.id + '-1-' + REPAIR_2961.actions.init);
  assert.equal(record.task.id, REPAIR_2961.actions.init);
  assert.equal(record.task.type, 'develop');
  assert.equal(record.task.issue, REPAIR_2961.issue);
  assert.equal(record.task.target_ref, REPAIR_2961.initSha);
  assert.equal(record.agent.provider, 'claude-code');
  assert.equal(record.agent.id, 'dev-qwen-01');
  assert.equal(record.agent.role, 'developer');
  assert.match(record.agent.model.id, /^qwen/);
  assert.equal(record.execution.tools.observed, true);
  assert.ok(record.execution.tools.by_name.Read >= 1);
  assert.ok((record.execution.tools.by_name.Edit ?? 0) +
    (record.execution.tools.by_name.Write ?? 0) >= 1);
  assert.ok(record.tokens.total > 0);
  assert.equal(record.result.status, 'proposed_not_published');
  pass(
    'The signed dev-qwen-01 Outbox dispatch ran the real Qwen Claude Code Developer in the isolated Worker, produced the validated SHA A patch and exact-SHA canonical telemetry with no privileged credentials.',
    [
      ...chain,
      { type: 'runtime', value: 'persisted canonical agent-develop telemetry ' +
        record.identity.unique_run_name + ' at ' + record.task.target_ref +
        ' records dev-qwen-01/' + record.agent.model.id + ', observed Read+Edit tools, ' +
        record.tokens.total + ' tokens and result ' + record.result.status },
    ],
  );
}

main().catch(fail);
