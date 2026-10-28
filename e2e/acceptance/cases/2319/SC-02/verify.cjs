'use strict';
// #2319 SC-02: on a merged staging SHA, a signed dev-qwen-01 task runs in the
// isolated staging Worker, produces the exact bounded edit, canonical
// Telemetry and an authenticated Store result receipt.
//
// The Case reads only the public append-only Store/Metrics branches. The
// deterministic signed-dispatch/admission rejection matrix is owned by the
// PR-boundary Agent Provider Gate; this Case owns the merged-SHA behavior.
const h = require('../../../shared/staging-developer-cases.cjs');

h.emit(h.withPublicBranches((branches) => {
  const sha = h.targetSha();
  const commitment = h.loadCheckpoint(branches, sha);
  if (commitment.status === 'pending') return commitment;
  if (h.stagedAncestor(commitment.source_sha) !== true) {
    return h.pending(
      'The committed checkpoint source ' + commitment.source_sha +
      ' is not provably in this staging target history yet.',
      [{ type: 'store', value: 'agent-store ' + branches.storeRef + ': checkpoint v' +
        commitment.head.version + ' source ' + commitment.source_sha }],
    );
  }
  const seedRun = h.loadSeedRun(branches, commitment);
  if (seedRun.status === 'pending') return seedRun;
  const records = h.loadTelemetry(branches);
  if (records.status === 'pending') return records;

  const seed = records.filter((record) =>
    record.identity.github_run_id === seedRun.run_id);
  if (seed.length === 0) {
    return h.pending(
      'The seed Run ' + seedRun.run_id + ' telemetry has not been ingested yet.',
      [{ type: 'store', value: 'checkpoint v' + commitment.head.version +
        ' seed run ' + seedRun.run_id + ' has no telemetry record' }],
    );
  }
  h.expect(seed.length === 1,
    'expected one seed telemetry record for Run ' + seedRun.run_id +
    ', found ' + seed.length);
  const record = seed[0];
  h.expect(record.identity.event === 'workflow_run',
    'seed telemetry is not from the authenticated workflow_run');
  h.expect(record.identity.github_workflow === 'Agent / Staging Developer Canary',
    'seed telemetry names a different workflow');
  h.expect(record.task?.phase === 'seed', 'seed telemetry phase is not seed');
  h.expect(record.task?.target_ref === commitment.source_sha,
    'seed telemetry is not bound to the exact staging target SHA');
  h.expect(/^[a-f0-9]{64}$/.test(record.task?.dispatch_id ?? ''),
    'seed telemetry has no signed dispatch identity');
  h.expect(record.agent?.provider === 'claude-code' &&
    record.agent?.id === 'dev-qwen-01' && record.agent?.role === 'developer',
  'seed telemetry is not the registered Claude Code Developer');
  h.expect(h.qwen(record.agent?.model?.id),
    'seed telemetry did not record a Qwen model');
  h.expect(Number(record.execution?.tools?.by_name?.Read) >= 1 &&
    Number(record.execution?.tools?.by_name?.Edit) >= 1,
  'seed telemetry does not show the observed Read+Edit bounded repair');
  h.expect(record.result?.status === 'staging-canary-pass',
    'seed Run did not pass the bounded synthetic repair');

  return {
    status: 'pass',
    summary: 'Staging Worker seed Run ' + seedRun.run_id + ' executed the signed ' +
      'dev-qwen-01 dispatch, performed the bounded Read+Edit repair and emitted ' +
      'canonical telemetry bound to ' + commitment.source_sha,
    evidence: [
      {
        type: 'store',
        value: 'agent-store ' + branches.storeRef + ': checkpoint v' +
          commitment.head.version + ' ' + commitment.head.checkpoint_path +
          ' ciphertext ' + commitment.ciphertext_sha256 + ' source ' +
          commitment.source_sha + ' harness ' +
          commitment.checkpoint.metadata.harness_digest,
      },
      {
        type: 'telemetry',
        value: 'seed Run ' + seedRun.run_id + ' dispatch ' + record.task.dispatch_id +
          ' provider claude-code model ' + record.agent.model.id +
          ' tools Read=' + record.execution.tools.by_name.Read +
          ' Edit=' + record.execution.tools.by_name.Edit +
          ' result staging-canary-pass target ' + record.task.target_ref,
      },
      {
        type: 'runtime',
        value: 'exact staging target ' + sha + ' with checkpoint source ' +
          commitment.source_sha + ' proven an ancestor of the target',
      },
    ],
  };
}));
