'use strict';
// #2274 SC-03: the real Qwen Developer session checkpoints at SHA A and
// resumes across a distinct GitHub Run at SHA B, with authenticated source,
// ciphertext-only remote checkpoints, pinned provider/model identity and
// fail-closed incompatible/tampered continuation fixtures.
const {
  targetSha, runNode, requireSummary, verifyQwenRepairChain2961, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const commit = runNode('scripts/lib/agent/orchestration/qwen-development-commit-selftest.mjs');
  requireSummary(commit,
    'Qwen signed Worker -> Store CAS -> Publisher write-ahead -> exact GitHub PR readback -> one Reviewer CAS and replay verified',
    'Qwen signed checkpoint/Store/Publisher replay');
  const worker = runNode('scripts/lib/agent/orchestration/qwen-development-worker-selftest.mjs');
  requireSummary(worker,
    'Qwen isolated Developer: signed Run admission, absent Store credentials, exact issue context and defensive prompt passed',
    'Qwen isolated Worker admission');
  pass(
    'The real Qwen Developer checkpointed at SHA A and resumed across a distinct GitHub Run at SHA B with authenticated source, ciphertext-only Store checkpoints, pinned provider/model identity and fail-closed tamper/incompatibility fixtures.',
    [
      ...chain,
      { type: 'runtime', value: 'qwen-development-commit-selftest: signed Worker -> Store CAS -> Publisher write-ahead -> exact GitHub PR readback -> one Reviewer CAS and replay verified; qwen-development-worker-selftest: signed Run admission, absent Store credentials and defensive prompt passed' },
    ],
  );
}

main().catch(fail);
