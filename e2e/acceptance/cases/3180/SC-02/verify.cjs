'use strict';
// #3180 SC-02: the Server GC operation is bounded and observable. One sweep
// deletes at most the configured candidate count / byte budget, deferred rows
// remain for a follow-up sweep, and referenced, aliased, leased and
// in-process-transferring blobs stay byte-identical.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = crateTests('nession-server', ['--lib', 'image::tests'], 600000);
  assertRan(output, [
    'image::tests::a_bounded_gc_defers_work_and_a_follow_up_sweep_resumes',
    'image::tests::a_byte_budget_defers_a_ready_image_instead_of_leaking_its_blob',
    'image::tests::gc_keeps_referenced_leased_and_transferring_images',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': a bound-limited sweep removed exactly one ' +
      'unreferenced image and deferred the rest; the next sweep resumed the ' +
      'deferred rows; a zero byte budget left a ready image and its blob ' +
      'untouched; referenced/leased/in-transfer images remained readable',
  });
  return 'A bounded Server GC sweep removes only proven unreferenced bytes, reports its outcome, leaves protected blobs byte-identical, and a follow-up sweep resumes the deferred work';
});
