'use strict';
// #1664 SC-05: Developer and Reviewer publish schema-validated Issue thread
// updates with role/id/run/attempt/SHA/outcome/evidence. After Review, the
// resumed Developer consumes the signed Issue projection before modifying its
// PR; no second inter-Agent message bus exists.
const {
  targetSha, runNode, requireSummary, requireSource, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const repair = runNode('scripts/lib/agent/orchestration/qwen-development-worker-selftest.mjs');
  requireSummary(repair,
    'Qwen Reviewer Issue-thread repair: signed Store transition, exact bot projection, native prompt synchronization and forgery denials pass',
    'Reviewer Issue-thread repair context');
  const reviewIngest = runNode('scripts/lib/agent/orchestration/reviewer-result-ingest-selftest.mjs');
  requireSummary(reviewIngest,
    'Trusted Reviewer Store CAS, Metrics, Issue projection and replay fixtures passed',
    'Reviewer Issue projection');
  const readback = runNode('scripts/lib/agent/publisher/publication-readback-selftest.mjs');
  requireSummary(readback,
    'Original real Publisher readback contract: exact triggering owner comment/Run time bound, old same-text owner command denied, Store intent, App PR, original commit, unique branch and SHA A/B replay negatives pass (no Reviewer asserted, no writes)',
    'Publisher readback contract');
  requireSource('scripts/lib/agent/orchestration/development-worker.mjs', [
    [/<!-- nession-review-result:v1:/, 'repair requires the signed Issue projection marker'],
    [/Verdict: `changes_requested`/, 'repair consumes the changes_requested verdict'],
    [/real Reviewer correction context has no signed Issue projection/, 'missing signed projection fails closed'],
    [/comments\.slice\(-3\)/, 'only a bounded latest Issue/PR delta reaches the resumed Developer'],
  ]);
  requireSource('scripts/lib/agent/orchestration/reviewer-result-ingest.mjs', [
    [/<!-- nession-review-result:v1:/, 'Reviewer result projects a signed Issue marker'],
    [/'\- Verdict: '\+tick/, 'Issue update carries the verdict'],
  ]);
  pass(
    'The Reviewer result projects one signed Issue update; the resumed Developer requires that exact projection and bounded latest delta before repairing; forged/missing context fails closed and no second message bus is used.',
    [
      { type: 'runtime', value: 'qwen-development-worker-selftest: signed Store transition + exact bot Issue projection + native prompt synchronization + forgery denials' },
      { type: 'runtime', value: 'reviewer-result-ingest-selftest: Store CAS, Metrics, Issue projection and replay fixtures' },
      { type: 'source', value: 'development-worker.mjs binds repair to the nession-review-result marker and Verdict: changes_requested; review ingest owns the same marker; exact SHA ' + target },
    ],
  );
}

main().catch(fail);
