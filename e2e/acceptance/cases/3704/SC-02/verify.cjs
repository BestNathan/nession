'use strict';
// #3704 SC-02: before-start vs started boundary, error text and readback.
const {run, targetSha, crateTests, assertRan, isolatedTmuxEnv} = require('../../../shared/mcp-cases.cjs');

run(({evidence}) => {
  const sha = targetSha();
  const mcp = crateTests('nession-mcp', ['--lib', 'pending_mutation::tests'], 600000);
  assertRan(mcp, [
    'pending_mutation::tests::caller_abandonment_prevents_queued_work_from_starting',
    'pending_mutation::tests::a_started_mutation_is_not_cancelled_halfway_through',
    'pending_mutation::tests::only_one_worker_can_claim_the_queued_operation',
  ]);
  const timeout = crateTests('nession-mcp', [
    '--lib', 'service::tests::execution_timeout_does_not_report_a_confirmed_failed_mutation',
  ], 600000);
  assertRan(timeout, [
    'service::tests::execution_timeout_does_not_report_a_confirmed_failed_mutation',
  ]);
  const running = crateTests('nession-agent', [
    '--lib', 'server::mcp::mcp_cancellation_tests',
  ], 900000, isolatedTmuxEnv('nession-3704-sc02'));
  assertRan(running, [
    'server::mcp::mcp_cancellation_tests::abandoned_queued_mutation_never_starts_after_lane_release',
    'server::mcp::mcp_cancellation_tests::started_mutation_finishes_even_after_caller_abandons_reply',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact staging ' + sha + ': atomic claim forbids late queue execution but preserves in-flight completion; timeout is a structured error with explicit rollback uncertainty/readback-before-retry instruction',
  });
  return 'Timed-out writes report uncertain outcomes; completed operations are not claimed rolled back';
});
