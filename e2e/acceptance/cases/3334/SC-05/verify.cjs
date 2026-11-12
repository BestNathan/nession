'use strict';
// #3334 SC-05: the Web contract observes durable build state, navigates away
// and back, and re-reads the authoritative inventory after reconnect.
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { webVitest } = require('../../../shared/web-vitest-cases.cjs');

const FILE = 'src/capabilities/images/__tests__/integration/ImagesWorkspace.test.tsx';
const TESTS = [
  'observes a running durable build, cancels it and offers retry',
  're-reads the durable build inventory after a reconnect',
];

run(({ evidence }) => {
  const sha = targetSha();
  webVitest(FILE, TESTS);
  webVitest(
    'src/product/project/components/__tests__/integration/ProjectImageReferenceField.test.tsx',
    [
      'submits an asynchronous build and requires an explicit Use this image',
      'recovers an active durable build after a remount',
    ],
  );
  evidence.push({
    type: 'runtime',
    value:
      'exact SHA ' + sha + ': the Images workspace rendered a running durable build with its real ' +
      'stage and measured file/byte counts, canceled it and offered retry; the build inventory was ' +
      're-read after reconnect; the Project field submitted asynchronously, required an explicit ' +
      'Use this image, preserved the old reference on failure, and recovered an active build after remount',
  });
  return 'Web/App observation, cancellation, retry, navigation return and reconnect read the durable build truth without inventing progress';
});
