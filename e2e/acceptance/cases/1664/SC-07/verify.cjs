'use strict';
// #1664 SC-07: after a published-PR Repair interruption, the canonical
// attestation accepts only the exact failed Run/stage, CAS-creates one
// bounded successor, restores the same encrypted native checkpoint, syncs the
// live Issue/PR delta and permissions, and the readback contract never starts
// a second PR or replays the mutation.
const {
  targetSha, runNode, requireSummary, requireSource, pass, fail,
} = require('../../../shared/agent-1664-cases.cjs');

async function main() {
  const target = targetSha();
  const repairFailure = runNode('scripts/lib/agent/orchestration/repair-runtime-failure-selftest.mjs');
  requireSummary(repairFailure,
    'Trusted Repair failure: exact Run/Artifact/Stage proof, bounded CAS successor, no blind POST',
    'published-PR Repair failure recovery');
  const nativeResume = runNode('scripts/lib/agent/orchestration/native-resume-failure-selftest.mjs');
  requireSummary(nativeResume,
    'Native Resume Failure: exact Run, 3 jobs, SDK pre-send log, artifacts, committed v1 negative tests passed',
    'native checkpoint restore');
  const preflight = runNode('scripts/lib/agent/orchestration/qwen-preflight-recovery-selftest.mjs');
  requireSummary(preflight,
    'Qwen preflight recovery: real Store CAS, exact GitHub source, one successor, replay, compromised Run/log/artifact negatives pass; Restore-key and Worker-image recovery repeats passed',
    'one-successor recovery');
  const repairPrompt = runNode('scripts/lib/agent/orchestration/qwen-development-worker-selftest.mjs');
  requireSummary(repairPrompt,
    'Qwen Reviewer Issue-thread repair: signed Store transition, exact bot projection, native prompt synchronization and forgery denials pass',
    'same-session Issue/PR synchronization');
  const readback = runNode('scripts/lib/agent/publisher/publication-readback-selftest.mjs');
  requireSummary(readback,
    'Original real Publisher readback contract: exact triggering owner comment/Run time bound, old same-text owner command denied, Store intent, App PR, original commit, unique branch and SHA A/B replay negatives pass (no Reviewer asserted, no writes)',
    'no second PR readback');
  requireSource('scripts/lib/agent/orchestration/repair-runtime-failure.mjs', [
    [/published-PR native Repair failure/, 'failure is bound to the published PR'],
    [/No model, writer,/, 'recovery has no model/writer side effects'],
    [/automatic replay/, 'recovery never automatically replays'],
  ]);
  pass(
    'A published-PR Repair interruption is attested by exact Run/Artifact/stage, creates one bounded CAS successor with no blind POST, restores the same encrypted native checkpoint and Issue/PR delta, and the readback contract forbids a second PR or replayed mutation.',
    [
      { type: 'runtime', value: 'repair-runtime-failure-selftest: exact published-PR Repair Run/Artifact/Stage proof, bounded CAS successor, no blind POST' },
      { type: 'runtime', value: 'native-resume-failure-selftest + qwen-preflight-recovery-selftest: exact Run/checkpoint restore, one successor, replay/compromise denial' },
      { type: 'runtime', value: 'qwen-development-worker-selftest: same-session repair requires signed Issue projection and current PR delta' },
      { type: 'runtime', value: 'publication-readback-selftest: unique branch/PR and SHA A/B replay negatives; exact SHA ' + target },
    ],
  );
}

main().catch(fail);
