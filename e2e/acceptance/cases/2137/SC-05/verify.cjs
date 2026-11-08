'use strict';
// #2137 SC-05: the resumed Developer restores its compatible encrypted native
// session, reads the latest Issue/PR review delta, edits the existing PR branch
// to SHA B, and the same Reviewer approves SHA B. Stale review/SHA, duplicate
// review events and role escalation are rejected.
const {
  targetSha, runNode, requireSummary, requireSource, verifyQwenRepairChain2961,
  pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const worker = runNode('scripts/lib/agent/orchestration/qwen-development-worker-selftest.mjs');
  requireSummary(worker,
    'Qwen Reviewer Issue-thread repair: signed Store transition, exact bot projection, native prompt synchronization and forgery denials pass',
    'Reviewer Issue-thread repair context');
  const commit = runNode('scripts/lib/agent/orchestration/qwen-development-commit-selftest.mjs');
  requireSummary(commit,
    'Qwen signed Worker -> Store CAS -> Publisher write-ahead -> exact GitHub PR readback -> one Reviewer CAS and replay verified',
    'Qwen repair checkpoint/CAS replay');
  requireSource('scripts/lib/agent/orchestration/development-worker.mjs', [
    [/<!-- nession-review-result:v1:/, 'repair requires the signed Issue projection marker'],
  ]);
  pass(
    'The SAME resumed dev-qwen-01 restored encrypted checkpoint v1, read the signed Reviewer Issue delta, edited the existing PR #2963 branch to SHA B and the same Reviewer approved SHA B; stale review/SHA, duplicate review events and role escalation are rejected by the canonical projection and CAS fixtures.',
    [
      ...chain,
      { type: 'runtime', value: 'qwen-development-worker-selftest: signed Store transition, exact bot projection, native prompt synchronization and forgery denials pass; qwen-development-commit-selftest: signed Worker -> Store CAS -> Publisher write-ahead -> PR readback -> one Reviewer CAS and replay verified' },
    ],
  );
}

main().catch(fail);
