'use strict';
// #3180 SC-05: diagnostics distinguish persisted Server Blob bytes from
// per-Agent cache bytes, stale/failed temporary artifacts and retention
// outcomes, so exhaustion can be attributed to the owning storage.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const agent = agentCacheTests('erofs_cache::tests::diagnostics_');
  assertRan(agent, [
    'erofs_cache::tests::diagnostics_separate_ready_bytes_from_temporary_artifacts',
  ]);
  const server = crateTests('nession-server', ['--lib', 'image::tests::diagnostics_'], 600000);
  assertRan(server, [
    'image::tests::diagnostics_separate_ready_bytes_failed_rows_and_temp_files',
  ]);
  evidence.push(
    {
      type: 'runtime',
      value: 'exact SHA ' + sha + ': Agent diagnostics reported ready blob bytes separately from temporary artifacts and stale partials, and a reconciliation removed only the stale artifact',
    },
    {
      type: 'runtime',
      value: 'exact SHA ' + sha + ': Server diagnostics reported ready/failed/building image rows separately from ready blob bytes and unpublished temporary files',
    },
  );
  return 'Server and Agent diagnostics attribute storage to its owner: ready Blob bytes, per-Agent cache bytes, stale/failed temporary artifacts and retention outcomes are reported separately';
});
