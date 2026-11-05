'use strict';
// #2735 SC-01: Darwin APFS detection resolves the backing device and requires
// positive same-device APFS classification. Different-device and non-APFS
// volumes are safe skips; an unclassifiable filesystem is a failed seed. The
// deterministic scenario is the regression that fails against the original
// directory-based diskutil call.
const {
  run, targetSha, selftestOutput, assertMarkers,
} = require('../../../shared/worktree-seed-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const output = selftestOutput();
  assertMarkers(output, [
    'darwin APFS detection classifies by backing device',
    'darwin different devices are a safe skip',
    'darwin non-APFS is a safe skip',
    'unexpected Darwin classification failure is a failed outcome',
  ]);
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': Darwin classification resolves stat -f %Sd to the backing BSD device, ' +
      'requires same-device APFS, and the fake-diskutil directory call from the pre-fix script cannot seed',
  });
  evidence.push({
    type: 'runtime',
    value: 'different devices and non-APFS are skipped without cloning; an unclassifiable filesystem is a failed outcome and publishes nothing',
  });
  return 'Darwin APFS detection classifies by backing device; the deterministic regression rejects the original directory-based call';
});
