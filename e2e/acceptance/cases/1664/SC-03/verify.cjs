'use strict';
// #1664 SC-03: the canonical state machine dispatches the Reviewer for SHA A,
// sends changes_requested to the SAME Developer as a resume repair, reviews
// SHA B and lets only deterministic policy select quality/acceptance. The
// real #2817 chain independently authenticates the Developer result and the
// Reviewer dispatch/approval for the exact published PR HEAD.
const {
  targetSha, runNode, requireSummary, requireSource, verifyQwenChain, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const stateMachine = runNode('scripts/lib/agent/development-selftest.mjs');
  requireSummary(stateMachine, 'agent development foundation self-test: passed',
    'canonical development state machine');
  requireSource('scripts/lib/agent/development-selftest.mjs', [
    [/drive\(event\('reviewer', 'changes_requested', 3\)\)/, 'changes_requested event is exercised'],
    [/assert\.equal\(state\.phase, 'repair'\)/, 'changes_requested enters repair'],
    [/assert\.equal\(actions\[0\]\.resume, true\)/, 'repair resumes the same Developer session'],
    [/drive\(event\('developer', 'implementation_ready', 4, 'b'\.repeat\(40\)\)\)/, 'repair produces SHA B'],
    [/drive\(event\('reviewer', 'approved', 5, 'b'\.repeat\(40\)\)\)/, 'Reviewer approves SHA B'],
    [/next_role:\s*'merge'/, 'model-supplied next_role is rejected'],
    [/model cannot/, 'model cannot choose the next role'],
    [/assert\.equal\(state\.phase, 'quality'\)/, 'approval deterministically enters quality'],
    [/assert\.equal\(actions\[0\]\.gate, 'sc-acceptance'\)/, 'acceptance selection is policy-owned'],
  ]);
  const chain = await verifyQwenChain(target);
  pass(
    'Canonical state machine proves Reviewer dispatch, changes_requested resume repair, SHA B approval and deterministic quality/acceptance selection; the real #2817 chain authenticates the Developer result and Reviewer dispatch for the exact PR HEAD.',
    [
      { type: 'runtime', value: 'development-selftest: SHA A -> reviewer dispatch; changes_requested -> phase=repair with actions[0].resume=true; Developer -> SHA B; Reviewer approved SHA B -> quality -> sc-acceptance; model next_role denied' },
      ...chain,
    ],
  );
}

main().catch(fail);
