'use strict';
// #1664 SC-04: duplicate/missed issue-comment, review and workflow-completion
// events, plus a failed downstream dispatch, reconcile to one authorized
// transition. Retry limits and terminal/wait states are explicit.
const {
  targetSha, runNode, requireSummary, requireSource, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const dispatch = runNode('scripts/lib/agent/orchestration/dispatch-intent-selftest.mjs');
  requireSummary(dispatch,
    'Write-ahead dispatch: real Git CAS, pending->prepared->acknowledged, crash/no-redelivery, exact HMAC ticket and replay denial passed',
    'dispatch intent reconciliation');
  const failed = runNode('scripts/lib/agent/orchestration/failed-dispatch-selftest.mjs');
  requireSummary(failed,
    'Failed Worker: unique next Action ID, old immutable Run, CAS, duplicate, unknown/204 and forged evidence denial passed',
    'failed downstream dispatch');
  const recover = runNode('scripts/lib/agent/orchestration/failed-worker-recover-selftest.mjs');
  requireSummary(recover,
    'Trusted failed-run recovery: exact native Run, job stage, claim, fork/duplicate and model-outcome denial passed',
    'failed Worker recovery');
  const ingest = runNode('scripts/lib/agent/orchestration/development-ingest-trigger-selftest.mjs');
  requireSummary(ingest,
    'Trusted Ingest replay: exact owner/main/source, fork, Issue, edited comment, manual Qwen Worker Run and event denial passed',
    'development ingest replay');
  requireSource('scripts/lib/agent/orchestration/transition.mjs', [
    [/max_repairs/, 'repair retry limit is explicit'],
    [/'blocked'/, 'terminal blocked state exists'],
    [/'waiting-merge'/, 'waiting-merge state exists'],
    [/repair_limit/, 'repair-limit notification is explicit'],
  ]);
  pass(
    'Write-ahead CAS, failed-dispatch, failed-Worker and ingest fixtures reconcile duplicate, missed, crash and timeout events to one authorized transition; retry limits and terminal/wait states are explicit.',
    [
      { type: 'runtime', value: 'dispatch-intent-selftest: pending->prepared->acknowledged, 204/crash no-redelivery, replay denied' },
      { type: 'runtime', value: 'failed-dispatch-selftest + failed-worker-recover-selftest: one successor Action, old Run immutable, duplicate/fork/unknown/204 denied' },
      { type: 'runtime', value: 'development-ingest-trigger-selftest: owner/main/source/Issue/comment/Worker-Run/event replay denied' },
      { type: 'source', value: 'transition.mjs owns max_repairs, repair_limit, blocked and waiting-merge; exact SHA ' + target },
    ],
  );
}

main().catch(fail);
