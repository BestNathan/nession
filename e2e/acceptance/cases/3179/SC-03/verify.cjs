'use strict';
// #3179 SC-03: both Compose Agent services use distinct durable cache
// volumes. With the same named volume, a recreated Agent container gets a
// verified warm digest hit with zero image-body transfer; corrupt bytes are
// rejected and re-fetched rather than returned as Ready.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  targetSha, runAsync, buildProbe, buildTestImage, startBlobServer,
  writeOverride, composeRun, composeDown, lastJson, uniqueProject,
} = require('../../../shared/compose-persistence-cases.cjs');

const BODY = Buffer.from('immutable-agent-cache-3179');
const PROBE_COMMAND = (blob) => [
  '/probe',
  '--cache-root', '/data/erofs',
  '--digest', blob.digest,
  '--url', blob.url,
  '--token', 'case-token',
];

runAsync(async ({ evidence }) => {
  const sha = targetSha();
  const blob = await startBlobServer(BODY);
  const probe = await buildProbe('nession-persistence-probes', 'nession-erofs-cache-probe');
  const image = await buildTestImage('nession-3179-minimal:test', { erofs: false });
  const project = uniqueProject('nession-3179-sc03');
  const override = writeOverride({
    project,
    tag: image,
    probes: { agent: probe, 'agent-remote': probe },
    extraHosts: ['host.docker.internal:host-gateway'],
  });

  try {
    for (const [service, profile] of [['agent', 'agent'], ['agent-remote', 'full']]) {
      const cold = lastJson((await composeRun(
        project, override, profile, service, PROBE_COMMAND(blob),
      )).stdout);
      assert.equal(cold.from_cache, false);
      assert.equal(cold.bytes_transferred, BODY.length);
      assert.equal(cold.blob_sha256, blob.digest.slice('sha256:'.length));
      assert.equal(cold.cache_root, '/data/erofs');

      const beforeWarm = blob.stats();
      await composeDown(project, override);
      const warm = lastJson((await composeRun(
        project, override, profile, service, PROBE_COMMAND(blob),
      )).stdout);
      assert.equal(warm.from_cache, true);
      assert.equal(warm.bytes_transferred, 0);
      assert.equal(warm.blob_sha256, blob.digest.slice('sha256:'.length));
      assert.deepEqual(blob.stats(), beforeWarm, 'a warm hit must not transfer body bytes');

      const digestHex = blob.digest.slice('sha256:'.length);
      // The probe reports the exact namespaced blob path; corrupt that file
      // rather than reconstructing the cache layout here.
      assert.match(cold.blob_path, new RegExp(`/sha256/${digestHex}$`));
      await composeRun(
        project, override, profile, service,
        ['sh', '-c', `printf corrupt > ${cold.blob_path}`],
      );
      const repaired = lastJson((await composeRun(
        project, override, profile, service, PROBE_COMMAND(blob),
      )).stdout);
      assert.equal(repaired.from_cache, false);
      assert.equal(repaired.bytes_transferred, BODY.length);
      assert.equal(repaired.blob_sha256, blob.digest.slice('sha256:'.length));

      evidence.push(
        {
          type: 'runtime',
          value: `exact SHA ${sha}: ${service} cold fetch ${blob.digest} transferred ${cold.bytes_transferred} bytes`,
        },
        {
          type: 'runtime',
          value: `${service} recreated with the same named volume: warm hit from /data/erofs, ` +
            `0 bytes transferred, server body counter unchanged at ${beforeWarm.bodyBytes}`,
        },
        {
          type: 'negative',
          value: `${service}: corrupt bytes were rejected and re-fetched (${repaired.bytes_transferred} verified bytes), never returned as Ready`,
        },
      );
    }
    return 'Both Compose Agent services keep distinct durable caches across recreation; warm hits transfer zero bytes and corrupt bytes are refetched';
  } finally {
    await composeDown(project, override, { volumes: true });
    fs.rmSync(override.dir, { recursive: true, force: true });
    await blob.close();
  }
});
