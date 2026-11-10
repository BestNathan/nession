'use strict';
// #3178 SC-02: both final Agent OCI image paths (from-source and prebuilt)
// expose `erofsfuse`, `fusermount3` and `fuse-overlayfs`; a compatible Linux
// runtime mounts and unmounts a verified EROFS fixture; a context without
// `/dev/fuse` fails closed instead of switching to Native.
//
// A runner without an unprivileged `/dev/fuse` keeps the criterion Pending
// with the measured prerequisite; it never fabricates a Pass.
const assert = require('node:assert/strict');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const { pending } = require('../../../shared/sandbox-cases.cjs');
const {
  guard, buildRuntimeTools, buildErofsUtilsBuilder, createFixture, removeFixture,
  runInImage, resultLine, probeFuseDevice, AGENT_MOUNT, AGENT_NEGATIVE,
} = require('../../../shared/runtime-image-cases.cjs');

const device = probeFuseDevice();
if (!device.ok) {
  pending('The runner cannot expose an unprivileged /dev/fuse to the Agent image proof', [
    { type: 'blocked', value: device.reason },
  ]);
} else {
  run(({ evidence }) => {
    const sha = targetSha();
    const guardSummary = guard();
    const builderTag = 'nession-3178-agent-builder';
    buildErofsUtilsBuilder('Dockerfile.agent', builderTag);
    const fixture = createFixture(builderTag);
    assert.match(fixture.magic, /^e2e1f5e0$/);
    assert.match(fixture.digest, /^[0-9a-f]{64}$/);
    const results = [];
    try {
      for (const [index, file] of ['Dockerfile.agent', 'Dockerfile.agent.prebuilt'].entries()) {
        const tag = 'nession-3178-agent-' + index;
        const image = buildRuntimeTools(file, tag);
        const mounted = resultLine(runInImage(tag, AGENT_MOUNT, {
          fuse: true,
          volumes: [fixture.dir + ':/fixture:ro'],
        }));
        const negative = resultLine(runInImage(tag, AGENT_NEGATIVE, {
          volumes: [fixture.dir + ':/fixture:ro'],
        }));
        assert.match(mounted, /digest=[0-9a-f]{64}/);
        assert.match(mounted, /helpers=[^ ]*erofsfuse/);
        assert.match(negative, /negative_reason=.+/);
        results.push({ file, image, mounted, negative });
      }
    } finally {
      removeFixture(fixture);
    }
    evidence.push(
      { type: 'static', value: 'exact SHA ' + sha + ': ' + guardSummary },
      ...results.flatMap(({ file, image, mounted, negative }) => [
        { type: 'runtime', value: file + ' runtime-tools image ' + image + ': ' + mounted },
        { type: 'negative', value: file + ' without /dev/fuse: ' + negative },
      ]),
      {
        type: 'runtime',
        value: 'fixture digest ' + fixture.digest + ' (magic e2e1f5e0) was mounted read-only, read back byte-for-byte, and unmounted with fusermount3',
      },
    );
    return 'Both final Agent image paths expose the FUSE helpers and mount/unmount a verified EROFS fixture; a context without /dev/fuse fails closed';
  });
}
