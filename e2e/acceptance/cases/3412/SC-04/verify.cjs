'use strict';
// #3412 SC-04: a restarted cache owner reconstructs verified/resumable state
// and bytes from durable files without a new transfer; a partial is inactive.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');
const { assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = agentCacheTests('cache::progress_tests::');
  assertRan(output, [
    'cache::progress_tests::restart_rebuilds_resumable_and_verified_progress_from_disk',
    'cache::progress_tests::progress_distinguishes_absent_resumable_and_verified',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': after reopening the same durable cache root and identity, a verified ' +
      'blob was Verified and a surviving .part was Resumable with its durable byte count and ' +
      'active=false; neither required a new transfer and no event replaced the snapshot',
  });
  return 'Restart/reconnect reconstruction from durable files and inactive resumable state are proven';
});
