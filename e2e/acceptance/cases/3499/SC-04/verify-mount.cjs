'use strict';
// #3499 SC-04 (mount): the physical mount is keyed on the EROFS layer digest,
// so two configs of one layer share one mount and release independently.
const { run, targetSha, assertRan, crateTests } = require('../../../shared/control-mode-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const mount = crateTests(
    'nession-erofs',
    ['--features', 'mount', 'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount'],
    600_000,
  );
  assertRan(mount, [
    'mount_manager::tests::two_consumers_of_one_layer_share_one_physical_mount',
  ]);
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': two consumers of one EROFS layer acquired the same physical ' +
      'mount, the remaining consumer kept it after one release, and the last release removed it',
  });
  return 'Two configs of one EROFS layer share one physical mount with independent release';
});
