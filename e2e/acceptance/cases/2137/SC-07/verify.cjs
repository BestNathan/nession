'use strict';
// #2137 SC-07: a real separate-fixture, executable post-merge Case proves
// crash/replay/missed-event paths and terminal outcomes, and the parent
// #1664 SC-03/04/05/07/17 are independently verified by their own Cases.
const {
  assert, api, targetSha, runNode, requireSummary, verifyQwenRepairChain2961,
  pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const repairFailure = runNode('scripts/lib/agent/orchestration/repair-runtime-failure-selftest.mjs');
  requireSummary(repairFailure,
    'Trusted Repair failure: exact Run/Artifact/Stage proof, bounded CAS successor, no blind POST',
    'published-PR Repair failure recovery');
  const dispatch = runNode('scripts/lib/agent/orchestration/dispatch-intent-selftest.mjs');
  requireSummary(dispatch,
    'Write-ahead dispatch: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed',
    'missed-event/replay reconciliation');
  const outbox = runNode('scripts/lib/agent/orchestration/outbox-selftest.mjs');
  requireSummary(outbox,
    'agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed',
    'terminal transition CAS');
  const parent = await api('/issues/1664');
  assert.equal(parent.state, 'closed');
  const rows = String(parent.body).split('\n').filter(line => /^\| SC-\d{2} \|/.test(line));
  assert.equal(rows.length, 18, 'parent #1664 must retain all 18 SC rows');
  assert.ok(rows.every(row => /\| Pass \|/.test(row)),
    'parent #1664 contains a non-Pass SC row');
  pass(
    'The controlled Qwen fixture provides a real separate post-merge Case, and the canonical failure/replay/outbox fixtures prove crash, missed-event, duplicate and terminal outcomes; parent #1664 SC-03/04/05/07/17 are independently verified by their own post-merge Cases.',
    [
      ...chain,
      { type: 'runtime', value: 'repair-runtime-failure-selftest: exact Run/Artifact/Stage proof, bounded CAS successor, no blind POST; dispatch-intent-selftest: crash/no-redelivery and replay denial; outbox-selftest: durable CAS and terminal transitions' },
      { type: 'runtime', value: 'parent #1664 is closed with 18/18 SC rows Pass, including SC-03/04/05/07/17' },
    ],
  );
}

main().catch(fail);
