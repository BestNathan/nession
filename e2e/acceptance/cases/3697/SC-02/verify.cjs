'use strict';
// #3697 SC-02: catalog GC, transfer/cache and the mount manager retain and
// verify every referenced device blob; a moved Tag makes the unreachable
// closure reclaimable, and an active composite view pins every component.
const { run, targetSha, crateTests, assertRan } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const catalog = crateTests(
    'nession-erofs',
    ['build::publication::tests::a_referenced_composite_publishes_its_whole_closure_and_gc_retains_every_device'],
    600_000,
  );
  assertRan(catalog, [
    'build::publication::tests::a_referenced_composite_publishes_its_whole_closure_and_gc_retains_every_device',
  ]);
  const transfer = crateTests(
    'nession-erofs',
    ['--features', 'cache', 'cache::fetch::tests::a_composite_'],
    600_000,
  );
  assertRan(transfer, [
    'cache::fetch::tests::a_composite_fetches_every_closure_object_and_returns_ordered_devices',
    'cache::fetch::tests::a_composite_grant_missing_a_device_fails_closed',
  ]);
  const mount = crateTests(
    'nession-erofs',
    ['--features', 'mount', 'mount_manager::tests::a_composite_view_identity_shares_one_physical_mount_and_pins_every_component'],
    600_000,
  );
  assertRan(mount, [
    'mount_manager::tests::a_composite_view_identity_shares_one_physical_mount_and_pins_every_component',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': a tagged Composite Manifest retained its config, ' +
      'descriptor, metadata and every device through descriptor edges; moving the ' +
      'Tag made the closure reclaimable after the bounded mark/grace sweep; the ' +
      'Agent grant fetched exactly the closure and refused a missing device; two ' +
      'consumers shared one physical view while the descriptor, metadata and both ' +
      'devices were pinned until the last release',
  });
  return 'catalog GC, Agent transfer/cache and the composite mount lease retain and verify every referenced device blob';
});
