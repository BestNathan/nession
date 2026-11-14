'use strict';
// #3412 SC-03: byte completion is Verifying, not mount-ready; corrupt bytes,
// refused grants and invalid ranges are failed/retryable and never Verified.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { agentCacheTests } = require('../../../shared/erofs-cache-cases.cjs');
const { assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const negative = agentCacheTests('cache::progress_negative_tests::');
  assertRan(negative, [
    'cache::progress_negative_tests::verifying_is_active_but_not_verified',
    'cache::progress_negative_tests::a_refused_grant_is_failed_without_a_partial',
    'cache::progress_negative_tests::transfer_details_redact_absolute_paths_and_bound_length',
  ]);
  // The corrupt-bytes case lives with the other successful-progress tests
  // (it needs a real download), so it is selected by its own module path.
  const corrupt = agentCacheTests(
    'cache::progress_tests::a_digest_mismatch_is_failed_not_verified',
  );
  assertRan(corrupt, [
    'cache::progress_tests::a_digest_mismatch_is_failed_not_verified',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': completing the byte stream produced Verifying while still active ' +
      '(not mount-ready); a digest mismatch and a refused/expired grant produced Failed with a ' +
      'bounded diagnostic; no case exposed a false Verified or a local cache path',
  });
  return 'Verification barrier, corrupt-bytes refusal, grant failure and bounded redacted diagnostics are proven';
});
