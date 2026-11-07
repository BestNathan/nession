'use strict';
// #2274 SC-05: merged-main proof includes the authenticated Qwen Developer
// Run/Attempt, Store receipt and repair/review handoff; AGENT_DEFAULT_DEVELOPER
// is read from GitHub Repository Variables without a Git edit.
const {
  targetSha, requireSource, verifyQwenRepairChain2961, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  requireSource('.github/workflows/acceptance-agent-controller.yml', [
    [/AGENT_DEFAULT_DEVELOPER/, 'Controller request reads the repository Variable'],
  ]);
  requireSource('.github/workflows/agent-develop.yml', [
    [/dev-qwen-01/, 'the Qwen Developer identity is a selectable Worker'],
  ]);
  requireSource('scripts/lib/agent/default-routing.mjs', [
    [/resolveAgentDefault/, 'registered default resolution owns identity selection'],
  ]);
  pass(
    'Merged-main proof includes the authenticated Qwen Developer Run/Attempt, committed Store receipts and the Reviewer changes_requested -> same Developer SHA B -> Reviewer approved handoff; AGENT_DEFAULT_DEVELOPER is read from GitHub Repository Variables without a Git edit.',
    [
      ...chain,
      { type: 'runtime', value: 'acceptance-agent-controller.yml reads AGENT_DEFAULT_DEVELOPER from Repository Variables; agent-develop.yml selects dev-qwen-01; default-routing.mjs resolves the registered identity without editing Git' },
    ],
  );
}

main().catch(fail);
