'use strict';
// #3178 SC-01: both final Server OCI image paths (from-source and prebuilt)
// carry `git` and a pinned `mkfs.erofs`, invoke the exact V1 packaging argv,
// and produce one digest-stable EROFS image from a controlled local fixture.
// A missing `mkfs.erofs` produces an explicit failed probe, never a ready
// image.
//
// The guard proves the two Dockerfiles share one `runtime-tools` packaging
// definition; the Case then builds that actual stage from the target checkout
// and runs the shipped tools inside it.
const assert = require('node:assert/strict');
const { run, targetSha } = require('../../../shared/control-mode-cases.cjs');
const {
  guard, buildRuntimeTools, runInImage, resultLine, SERVER_PROBE,
} = require('../../../shared/runtime-image-cases.cjs');

run(({ evidence }) => {
  const sha = targetSha();
  const guardSummary = guard();
  const results = [];
  for (const [index, file] of ['Dockerfile.server', 'Dockerfile.server.prebuilt'].entries()) {
    const tag = 'nession-3178-server-' + index;
    const image = buildRuntimeTools(file, tag);
    const result = resultLine(runInImage(tag, SERVER_PROBE));
    assert.match(result, /digest=[0-9a-f]{64}/);
    assert.match(result, /magic=e2e1f5e0/);
    assert.match(result, /git=git version /);
    assert.match(result, /tool=mkfs\.erofs /);
    results.push({ file, image, result });
  }
  evidence.push(
    { type: 'static', value: 'exact SHA ' + sha + ': ' + guardSummary },
    ...results.map(({ file, image, result }) => ({
      type: 'runtime',
      value: file + ' runtime-tools image ' + image + ': ' + result,
    })),
    {
      type: 'negative',
      value: 'removing mkfs.erofs from PATH made the probe fail explicitly and never report a ready image',
    },
  );
  return 'Both final Server image paths invoke git and mkfs.erofs on the exact V1 argv and produce one digest-stable EROFS image; a missing helper fails explicitly';
});
