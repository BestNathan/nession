'use strict';
// #2137 SC-03: Store-backed write-ahead intent, deterministic branch/PR
// identity, external GitHub PR receipt and CAS/replay reconciliation permit at
// most one PR after a crash between publication and checkpoint.
const {
  targetSha, runNode, requireSummary, verifyQwenRepairChain2961, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const dispatch = runNode('scripts/lib/agent/orchestration/dispatch-intent-selftest.mjs');
  requireSummary(dispatch,
    'Write-ahead dispatch: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed',
    'write-ahead dispatch reconciliation');
  const outbox = runNode('scripts/lib/agent/orchestration/outbox-selftest.mjs');
  requireSummary(outbox,
    'agent Issue outbox: durable CAS, trusted result transitions and replay fixtures passed',
    'Store outbox CAS');
  pass(
    'The controlled Qwen chain commits both Publisher write-ahead intents, uses one deterministic branch/PR and the externally observed PR #2963 receipt, and the canonical CAS/replay fixtures permit at most one PR while conflicting SHA, fork, source Run/Attempt and unbounded retries fail closed.',
    [
      ...chain,
      { type: 'runtime', value: 'dispatch-intent-selftest: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed; outbox-selftest: durable CAS, trusted result transitions and replay fixtures passed' },
    ],
  );
}

main().catch(fail);
