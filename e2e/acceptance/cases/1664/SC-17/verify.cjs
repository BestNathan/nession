'use strict';
// #1664 SC-17: a separate controlled fixture Issue/PR must demonstrate the
// real Developer -> Reviewer changes_requested -> resumed Developer -> Reviewer
// approved chain, the exact-SHA Quality Gate and eligible acceptance evidence.
// The canonical state-machine selftest proves the policy; the pinned real
// #2961 Qwen chain proves the executed lifecycle without self-acceptance.
const {
  targetSha, runNode, requireSummary, requireSource,
  verifyQwenRepairChain2961, pass, fail,
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
    [/assert\.equal\(state\.phase, 'quality'\)/, 'approval deterministically enters quality'],
    [/assert\.equal\(actions\[0\]\.gate, 'sc-acceptance'\)/, 'acceptance selection is policy-owned'],
  ]);
  const chain = await verifyQwenRepairChain2961(target);
  pass(
    'The controlled #2961 fixture proves the real Qwen Developer -> Reviewer changes_requested -> resumed Developer -> Reviewer approved chain, the exact-SHA Quality Gate and eligible acceptance runs; the canonical state machine independently owns the transition policy and forbids model-chosen roles.',
    [
      { type: 'runtime', value: 'development-selftest: SHA A -> reviewer dispatch; changes_requested -> phase=repair with actions[0].resume=true; Developer -> SHA B; Reviewer approved SHA B -> quality -> sc-acceptance; model next_role denied' },
      ...chain,
    ],
  );
}

main().catch(fail);
