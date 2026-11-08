'use strict';
// #2137 SC-06: exact PR SHA B Quality, E2E and eligible Agent/Case Acceptance
// are independently successful, with authenticated Reviewer/Developer/
// Publisher/Store and metrics-source receipts linked to the controlled Qwen
// fixture and parent #1664.
const {
  assert, targetSha, verifyRun, verifyQwenRepairChain2961, rawMetrics,
  REPAIR_2961, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

const REVIEW_RECORD_A = 'raw/workflows/agent-review/2026-11-07/' +
  '42402597971-1-issue-2961-review.json';
const REVIEW_RECORD_B = 'raw/workflows/agent-review/2026-11-07/' +
  '42403363557-1-issue-2961-review.json';
const DEV_RECORD_A = 'raw/workflows/agent-develop/2026-11-07/' +
  '42401513247-1-' + REPAIR_2961.actions.init + '.json';
const DEV_RECORD_B = 'raw/workflows/agent-develop/2026-11-07/' +
  '42403004351-1-' + REPAIR_2961.actions.repair + '.json';

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const e2e = await verifyRun(42403269775, {
    attempt: 1, name: 'E2E / Tests', path: '.github/workflows/e2e-tests.yml',
    event: 'pull_request', headSha: REPAIR_2961.shaB,
    actor: 'nession-publisher[bot]', headBranch: REPAIR_2961.branch,
  });
  const smoke = await verifyRun(42403269793, {
    attempt: 1, name: 'Acceptance / Case Smoke',
    path: '.github/workflows/acceptance-case-smoke.yml', event: 'pull_request',
    headSha: REPAIR_2961.shaB, actor: 'nession-publisher[bot]',
    headBranch: REPAIR_2961.branch,
  });
  const records = await Promise.all([DEV_RECORD_A, DEV_RECORD_B,
    REVIEW_RECORD_A, REVIEW_RECORD_B].map(async path =>
    JSON.parse((await rawMetrics(path)).toString('utf8'))));
  const [devA, devB, reviewA, reviewB] = records;
  assert.equal(devA.kind, 'agent_workflow_run');
  assert.equal(devA.identity.github_run_id, REPAIR_2961.runs.developerA.id);
  assert.equal(devA.agent.id, 'dev-qwen-01');
  assert.equal(devA.task.issue, REPAIR_2961.issue);
  assert.equal(devB.identity.github_run_id, REPAIR_2961.runs.developerB.id);
  assert.equal(devB.agent.id, 'dev-qwen-01');
  assert.equal(devB.task.issue, REPAIR_2961.issue);
  assert.equal(reviewA.kind, 'agent_workflow_run');
  assert.equal(reviewA.identity.github_run_id, REPAIR_2961.runs.reviewerA.id);
  assert.equal(reviewA.agent.id, 'review-qwen-01');
  assert.equal(reviewA.task.issue, REPAIR_2961.issue);
  assert.equal(reviewB.identity.github_run_id, REPAIR_2961.runs.reviewerB.id);
  assert.equal(reviewB.agent.id, 'review-qwen-01');
  assert.equal(reviewB.task.issue, REPAIR_2961.issue);
  pass(
    'Exact PR SHA B Quality, E2E and eligible Case/Acceptance runs are independently successful, with committed Store transitions and persisted Developer/Reviewer metrics receipts linked to the controlled Qwen fixture and parent #1664.',
    [
      ...chain,
      { type: 'runtime', value: 'E2E / Tests ' + e2e.id + '/1 and Acceptance / Case Smoke ' +
        smoke.id + '/1 completed successfully at SHA B ' + REPAIR_2961.shaB },
      { type: 'runtime', value: 'persisted metrics receipts for Developer runs ' +
        devA.identity.github_run_id + '/' + devB.identity.github_run_id +
        ' and Reviewer runs ' + reviewA.identity.github_run_id + '/' +
        reviewB.identity.github_run_id + ' all bind issue ' + REPAIR_2961.issue },
    ],
  );
}

main().catch(fail);
