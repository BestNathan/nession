'use strict';
// #2010 SC-05: negative fixtures cover stale Store CAS, wrong Run, replayed/
// forged Ticket, role escalation, cross-Issue routing and crash between POST
// and ACK; Quality, E2E and Acceptance Case Smoke pass at the producer PR head.
const {
  assert, api, runNode, requireSummary, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

// Exact-head producer PR #2968 (merged main Case work). Its pull_request
// Quality, E2E and Case Smoke runs completed successfully before this Case was
// merged, so the SC-05 check requirement is bound to a finished exact SHA.
const PRODUCER_SHA = 'b1d8fc3698c9f444d1394a552b048df37ea9fc80';

async function main() {
  const dispatch = runNode('scripts/lib/agent/orchestration/dispatch-intent-selftest.mjs');
  requireSummary(dispatch,
    'Write-ahead dispatch: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed',
    'stale CAS/crash/replay negatives');
  const preflight = runNode('scripts/lib/agent/orchestration/worker-preflight-selftest.mjs');
  requireSummary(preflight,
    'Worker read-only preflight: real Git Store Run/ACK, committed Ticket SHA, registered role and forged/early execution negatives passed',
    'wrong Run/forged ticket/role escalation negatives');
  const controller = runNode('scripts/lib/agent/orchestration/controller-dispatch-selftest.mjs');
  requireSummary(controller,
    'Qwen signed Reviewer dispatch: one immutable Store branch, actual SHA fetch, two ancestry checks, untrusted source and replay negatives pass',
    'cross-Issue/role/replay dispatch negatives');
  const listing = await api('/actions/runs?head_sha=' + PRODUCER_SHA + '&per_page=100');
  assert.ok(Array.isArray(listing.workflow_runs), 'producer run listing is malformed');
  for (const [name, path] of [
    ['CI / Quality Gate', '.github/workflows/ci-quality.yml'],
    ['E2E / Tests', '.github/workflows/e2e-tests.yml'],
    ['Acceptance / Case Smoke', '.github/workflows/acceptance-case-smoke.yml'],
  ]) {
    const matches = listing.workflow_runs.filter(run =>
      run.name === name && run.path === path);
    assert.ok(matches.length >= 1, name + ' is missing at producer SHA ' + PRODUCER_SHA);
    assert.ok(matches.every(run => run.status === 'completed' &&
      run.conclusion === 'success'),
    name + ' did not complete successfully at producer SHA ' + PRODUCER_SHA);
  }
  pass(
    'Negative fixtures cover stale Store CAS, wrong Run, replayed/forged Ticket, role escalation, cross-Issue routing and crash between POST and ACK; CI Quality, E2E and Acceptance Case Smoke all completed successfully at the producer PR head.',
    [
      { type: 'runtime', value: 'dispatch-intent-selftest: crash/no-redelivery, exact HMAC ticket and replay denial passed; worker-preflight-selftest: wrong Run/ACK, forged ticket, role escalation and cross-Issue negatives passed; controller-dispatch-selftest: untrusted source, ancestry and replay negatives passed' },
      { type: 'runtime', value: 'CI / Quality Gate, E2E / Tests and Acceptance / Case Smoke completed successfully at ' + PRODUCER_SHA },
    ],
  );
}

main().catch(fail);
