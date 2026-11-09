'use strict';
// #3022 SC-05: failures, leases, project references and restart preserve the
// boundary; GC never exposes a partial blob as ready or deletes a protected one.
const { run, targetSha, assertRan } = require('../../../shared/control-mode-cases.cjs');
const { runCargoTests } = require('../../../shared/erofs-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = runCargoTests('nession-server', 'image::tests');
  assertRan(output, [
    'image::tests::a_failed_build_is_recoverable_and_never_offers_partial_bytes',
    'image::tests::gc_keeps_referenced_leased_and_transferring_images',
    'image::tests::restart_preserves_image_metadata_and_project_references',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a failed build stayed failed with no digest/bytes; GC removed only the unreferenced image and kept the Project-referenced, leased and actively transferred images; reopening the same SQLite file preserved metadata and the Project reference',
  });
  return 'Build/download failures and GC cannot delete a referenced, leased or transferring image or expose partial blobs as ready, and restart preserves metadata and references';
});
