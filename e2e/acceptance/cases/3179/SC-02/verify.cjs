'use strict';
// #3179 SC-02: a recreated Compose Server container with the same named
// volume resolves the same ready image digest and byte-identical blob, with no
// new EROFS build. The test image is a bounded Ubuntu runtime for the
// host-built Server probe; the Compose service environment and named volumes
// are the real deployed contract. The post-recreation image deliberately has
// no `mkfs.erofs`, so a would-be rebuild fails instead of passing silently.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  targetSha, runAsync, buildProbe, buildTestImage, writeOverride,
  composeRun, composeDown, lastJson, uniqueProject,
} = require('../../../shared/compose-persistence-cases.cjs');

runAsync(async ({ evidence }) => {
  const sha = targetSha();
  const buildImage = await buildTestImage('nession-3179-erofs:test', { erofs: true });
  const getImage = await buildTestImage('nession-3179-minimal:test', { erofs: false });
  const probe = await buildProbe('nession-persistence-probes', 'nession-image-persist-probe');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3179-fixture-'));
  fs.writeFileSync(path.join(fixture, 'hello.txt'), 'persistent image\n');
  const project = uniqueProject('nession-3179-sc02');
  const buildOverride = writeOverride({
    project,
    tag: buildImage,
    probes: { server: probe },
    mounts: { server: [fixture + ':/fixture:ro'] },
  });
  const getOverride = writeOverride({ project, tag: getImage, probes: { server: probe } });

  try {
    const built = lastJson((await composeRun(
      project, buildOverride, 'server', 'server',
      ['/probe', '-', 'build', '/fixture'],
    )).stdout);
    assert.equal(built.status, 'Ready');
    assert.match(built.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(built.blob_sha256, built.digest.slice('sha256:'.length));
    assert.equal(built.db_path, '/data/server/server.db');
    assert.equal(built.image_blob_dir, '/data/server/images/blobs');
    assert.equal(built.image_build_dir, '/data/server/images/build');

    await composeDown(project, buildOverride);

    const fetched = lastJson((await composeRun(
      project, getOverride, 'server', 'server',
      ['/probe', '-', 'get', built.digest],
    )).stdout);
    assert.equal(fetched.status, 'Ready');
    assert.equal(fetched.digest, built.digest);
    assert.equal(fetched.image_id, built.image_id);
    assert.equal(fetched.created_at, built.created_at);
    assert.equal(fetched.blob_sha256, built.blob_sha256);
    assert.equal(fetched.db_path, '/data/server/server.db');

    evidence.push(
      {
        type: 'runtime',
        value: `exact SHA ${sha}: first Compose Server container built ${built.digest} ` +
          `(blob sha256 ${built.blob_sha256}) under /data/server with image row ${built.image_id}`,
      },
      {
        type: 'runtime',
        value: `after stop/remove and recreation with the same named volume, ` +
          `server.image.get returned ${fetched.digest} with the same image row and blob SHA-256`,
      },
      {
        type: 'negative',
        value: 'the post-recreation image has no mkfs.erofs; a rebuild would fail, so the ready result proves no new build',
      },
    );
    return 'A recreated Compose Server with the same named volume returns the same ready digest and byte-identical blob without a new build';
  } finally {
    await composeDown(project, getOverride, { volumes: true });
    fs.rmSync(fixture, { recursive: true, force: true });
    for (const override of [buildOverride, getOverride]) {
      fs.rmSync(override.dir, { recursive: true, force: true });
    }
  }
});
