'use strict';
// #2319 SC-03: two distinct authenticated staging Runs persist a ciphertext-only
// native Qwen Session to the isolated Store, restore the same Session UUID in a
// later Run, and keep the pinned provider/model.
//
// The Case reads only the public append-only Store/Metrics branches. Tampered or
// mismatched checkpoint commitments are rejected by the signed-dispatch
// verifier and its PR-boundary negative fixtures; this Case owns the merged-SHA
// positive restore receipt.
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
  const metadata = commitment.checkpoint.metadata;
  if (!h.UUID.test(metadata.session_id ?? '')) {
    return h.pending(
      'The committed checkpoint does not yet carry the native Session identity.',
      [{ type: 'store', value: 'checkpoint v' + commitment.head.version +
        ' metadata lacks session_id' }],
    );
  }
  const seedRun = h.loadSeedRun(branches, commitment);
  if (seedRun.status === 'pending') return seedRun;
  const records = h.loadTelemetry(branches);
  if (records.status === 'pending') return records;

  const seed = records.filter((record) =>
    record.identity.github_run_id === seedRun.run_id);
  h.expect(seed.length === 1,
    'expected one seed telemetry record for Run ' + seedRun.run_id +
    ', found ' + seed.length);
  const seedModel = seed[0].agent?.model?.id;
  h.expect(h.qwen(seedModel), 'seed Run did not record a Qwen model');
  // The checkpoint's public harness digest binds source/model/CLI; the trusted
  // restore recomputes it from the signed dispatch before decrypting.

  const resumes = records.filter((record) =>
    record.task?.phase === 'resume' &&
    record.task?.checkpoint_version === commitment.head.version &&
    record.task?.checkpoint_ciphertext_sha256 === commitment.ciphertext_sha256);
  if (resumes.length === 0) {
    return h.pending(
      'No resume Run is yet bound to committed checkpoint v' +
      commitment.head.version + '.',
      [{ type: 'store', value: 'checkpoint v' + commitment.head.version +
        ' ciphertext ' + commitment.ciphertext_sha256 + '; no bound resume telemetry' }],
    );
  }
  for (const record of resumes) {
    h.expect(record.identity.event === 'workflow_run',
      'resume telemetry is not from the authenticated workflow_run');
    h.expect(record.identity.github_run_id > seedRun.run_id,
      'a bound resume Run is not later than the seed Run');
    h.expect(record.task?.target_ref === commitment.source_sha,
      'resume telemetry is not bound to the exact staging target SHA');
    h.expect(record.agent?.provider === 'claude-code' &&
      record.agent?.id === 'dev-qwen-01' && record.agent?.role === 'developer',
    'resume telemetry is not the registered Claude Code Developer');
    h.expect(record.agent?.model?.id === seedModel,
      'resume Run changed the pinned model ' + seedModel +
      ' to ' + record.agent?.model?.id);
    h.expect(record.agent?.run_id === metadata.session_id,
      'resume Run ' + record.identity.github_run_id +
      ' did not restore the stored Session UUID ' + metadata.session_id);
    h.expect(record.result?.status === 'staging-resume-pass',
      'resume Run ' + record.identity.github_run_id +
      ' did not pass the native Session restore');
  }

  return {
    status: 'pass',
    summary: 'Staging checkpoint v' + commitment.head.version + ' persisted a ' +
      'ciphertext-only native Qwen Session in Run ' + seedRun.run_id +
      ' and ' + resumes.length + ' later Run(s) restored the same UUID with the ' +
      'pinned model ' + seedModel,
    evidence: [
      {
        type: 'store',
        value: 'agent-store ' + branches.storeRef + ': checkpoint v' +
          commitment.head.version + ' ciphertext ' + commitment.ciphertext_sha256 +
          ' session ' + metadata.session_id + ' source ' + commitment.source_sha +
          ' harness ' + metadata.harness_digest,
      },
      {
        type: 'telemetry',
        value: 'seed Run ' + seedRun.run_id + ' model ' + seedModel +
          ' dispatched default ' + seed[0].task?.dispatched_default_model +
          ' result ' + seed[0].result?.status,
      },
      {
        type: 'telemetry',
        value: resumes.map((record) => 'resume Run ' + record.identity.github_run_id +
          ' session ' + record.agent.run_id + ' model ' + record.agent.model.id +
          ' result ' + record.result.status).join('; '),
      },
      {
        type: 'runtime',
        value: 'exact staging target ' + sha + ' with checkpoint source ' +
          commitment.source_sha + ' proven an ancestor of the target; ' +
          'tampered/mismatched commitments remain rejected by the signed ' +
          'dispatch verifier and its PR-boundary negative fixtures',
      },
    ],
  };
}));
