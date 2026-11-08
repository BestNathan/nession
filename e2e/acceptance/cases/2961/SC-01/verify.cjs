'use strict';
// #2961 SC-01: the controlled v4 fixture must prove the real Qwen Developer
// phase 1 publication, a genuine Reviewer changes_requested finding, the SAME
// resumed Developer repairing at SHA B, and Reviewer approval of SHA B.
const {
  targetSha, verifyQwenRepairChain2961, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const chain = await verifyQwenRepairChain2961(target);
  pass(
    'The real Qwen Developer published phase 1 at SHA A, the Reviewer requested the missing verification marker, the resumed same Developer repaired SHA B, and the same Reviewer approved SHA B.',
    chain,
  );
}

main().catch(fail);
