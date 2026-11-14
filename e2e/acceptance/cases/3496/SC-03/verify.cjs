'use strict';
// #3496 SC-03: GC retains every object reachable from Tags and live pins
// through descriptor edges, and reclaims only unreachable objects after the
// bounded mark → grace → recheck path. Durable marks survive a reopened
// catalog, and one in-process writer lock serializes publication with a sweep.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const gc = crateTests('nession-erofs', ['catalog::gc::tests'], 600_000);
  assertRan(gc, [
    'catalog::gc::tests::gc_marks_then_deletes_only_unreachable_objects_after_grace',
    'catalog::gc::tests::a_pin_or_new_tag_reprieves_a_marked_object',
    'catalog::gc::tests::durable_marks_bounded_sweeps_and_restarts_still_reclaim',
  ]);
  const concurrent = crateTests(
    'nession-erofs',
    ['image::tests::the_catalog_lock_serializes_publication_and_gc'],
    600_000,
  );
  assertRan(concurrent, [
    'image::tests::the_catalog_lock_serializes_publication_and_gc',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a tagged Manifest and each of its Config/EROFS ' +
      'descriptor children stayed reachable while an untagged graph was marked ' +
      'first, then reclaimed only after the grace window; a Session pin and a new ' +
      'Tag reprieved a marked graph; durable marks survived closing and reopening ' +
      'the SQLite catalog; bounded sweeps deleted one object per pass and reported ' +
      'the deferred remainder; concurrent publish + GC completed with one writer lock',
  });
  return 'GC retains descriptor-reachable objects and reclaims only unreachable ones after a durable, bounded grace/recheck sweep';
});
