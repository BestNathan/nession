'use strict';
// #3334 SC-04: bounded concurrent workers, per-build isolation, duplicate-submit
// idempotency, one execution per build id, refused multi-owner build roots and
// GC/cleanup that never delete live work.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const lifecycle = runCargoTests('nession-server', 'image::async_build_tests');
  assertRan(lifecycle, [
    'image::async_build_tests::concurrent_builds_respect_the_worker_limit_and_do_not_share_workspaces',
    'image::async_build_tests::duplicate_submission_is_idempotent_and_legacy_build_returns_a_ready_image',
    'image::async_build_tests::a_second_manager_on_one_build_root_is_refused',
    'image::async_build_tests::gc_skips_a_building_row_owned_by_a_live_build',
    'image::async_build_tests::cleanup_expires_terminal_directories_but_never_active_work',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': three concurrent submissions entered at most two workers with ' +
      'distinct workspaces and digests; duplicate client submission returned one record; a second ' +
      'manager on the same build root was refused while the first held it; GC skipped a building ' +
      'row protected by a live durable build; bounded cleanup removed only expired terminal ' +
      'directories and never active work',
  });
  return 'Concurrency, isolation, single ownership, idempotency and bounded cleanup hold without deleting live or published work';
});
