'use strict';
// #2137 SC-04: an authentic separate Reviewer at the actual PR HEAD emits a
// schema-validated changes_requested result and authenticated policy dispatches
// the SAME Developer identity; the model cannot choose next_role.
const {
  targetSha, runNode, requireSummary, requireSource, verifyQwenRepairChain2961,
  pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  const state = runNode('scripts/lib/agent/development-selftest.mjs');
  requireSummary(state, 'agent development foundation self-test: passed',
    'canonical development state machine');
  requireSource('scripts/lib/agent/development-selftest.mjs', [
    [/drive\(event\('reviewer', 'changes_requested', 3\)\)/, 'changes_requested event is exercised'],
    [/assert\.equal\(state\.phase, 'repair'\)/, 'changes_requested enters repair'],
    [/assert\.equal\(actions\[0\]\.resume, true\)/, 'repair resumes the same Developer session'],
    [/next_role:\s*'merge'/, 'model-supplied next_role is rejected'],
    [/model cannot/, 'model cannot choose the next role'],
  ]);
  pass(
    'An authentic separate Reviewer examined the actual SHA A PR HEAD, emitted a schema-validated changes_requested result in the Issue thread, and authenticated policy dispatched the same dev-qwen-01 identity to repair; the canonical state machine rejects a model-supplied next_role.',
    [
      ...chain,
      { type: 'runtime', value: 'development-selftest: changes_requested -> phase=repair with actions[0].resume=true; model-supplied next_role rejected' },
    ],
  );
}

main().catch(fail);
