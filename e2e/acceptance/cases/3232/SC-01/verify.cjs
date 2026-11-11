'use strict';
// SC-01: archived configuration resolves durable paths to the archived home.
//
// The Current Server config is initialized by the real CLI (so the generated
// absolute db/image defaults are on disk), Current is archived by the real
// install transaction, and the real archived Server is started with its
// archived config. The database must appear under versions/<old>/server, never
// under the Current home. Explicit external paths survive; unsafe in-home
// paths refuse the archive instead of silently reading Current data.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, assertCliSucceeds, runCliAsync, installEnv,
  makeRealReleaseTarball, writeRealInstall, startReleaseServer,
  freePort, waitForTcp, tomlString, assertUnder, runBinary, readIdentity, main,
} = require('../../../shared/release-hardening-cases.cjs');

const TARGET = '1.2.0';
const OLD = '0.35.0';

function generatedHome(base, label) {
  const home = mkdirPrivate(path.join(base, label));
  const installDir = path.join(base, label + '-install');
  writeRealInstall(installDir);
  const runtime = mkdirPrivate(path.join(base, label + '-runtime'));
  const env = installEnv({ home, installDir, runtimeDir: runtime });
  return { home, installDir, runtime, env };
}

async function writeGeneratedConfig(ctx, apiBase) {
  const env = apiBase ? { ...ctx.env, NESSION_UPDATE_API_URL: apiBase } : ctx.env;
  assertCliSucceeds(runCli(['config', 'server', 'init'], env), 'config server init');
  const config = path.join(ctx.home, 'server-config.toml');
  const port = await freePort();
  assertCliSucceeds(
    runCli(['config', 'server', 'set', 'listen_address', '127.0.0.1:' + port], env),
    'config server set listen_address',
  );
  fs.mkdirSync(path.join(ctx.home, 'server/images/blobs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.home, 'server/images/blobs/current-marker'), 'current-state');
  fs.mkdirSync(path.join(ctx.home, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(ctx.home, 'agent/identity'), 'current-agent-state');
  return { config, port };
}

async function install(ctx, apiBase, label) {
  const result = await runCliAsync(
    ['install', TARGET, '--yes'],
    { ...ctx.env, NESSION_UPDATE_API_URL: apiBase },
    90_000,
    label,
  );
  assert.equal(result.status, 0, label + ' failed: ' + (result.stderr || result.stdout));
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];
  const base = makeRoot('sc01-paths');

  const release = makeRealReleaseTarball(base, TARGET);
  const server = await startReleaseServer({
    [TARGET]: { ...release, checksum: release.checksum },
  });

  try {
    // 1. Real Current + real generated config.
    const current = generatedHome(base, 'current');
    const { config, port } = await writeGeneratedConfig(current);
    const generated = fs.readFileSync(config, 'utf8');
    assert.match(generated, /db_path = ".*\/server\/server\.db"/);
    assert.match(generated, /image_blob_dir = ".*\/server\/images\/blobs"/);
    assert.match(generated, /image_build_dir = ".*\/server\/images\/build"/);
    assertUnder(tomlString(config, 'db_path'), current.home, 'Current db_path');
    evidence.push({
      type: 'runtime',
      value: 'config server init persisted absolute defaults under the Current home: ' +
        tomlString(config, 'db_path'),
    });

    // 2. Archive Current with the real transaction.
    await install(current, server.base, 'install current');
    const archive = path.join(current.home, 'versions', OLD);
    const archivedConfig = path.join(archive, 'server-config.toml');
    assert.ok(fs.existsSync(archivedConfig), 'archived server config is missing');
    for (const key of ['db_path', 'image_blob_dir', 'image_build_dir']) {
      const value = tomlString(archivedConfig, key);
      assert.ok(value, 'archived config has no ' + key);
      assertUnder(value, archive, 'archived ' + key);
    }
    assert.ok(
      fs.existsSync(path.join(archive, 'server/images/blobs/current-marker')),
      'the Current durable state was not archived with the release',
    );
    assert.ok(
      fs.existsSync(path.join(archive, 'agent/identity')),
      'the Current agent state was not archived with the release',
    );
    assert.ok(!fs.existsSync(path.join(current.home, 'server')), 'Current server state still exists');
    evidence.push({
      type: 'runtime',
      value: 'install archived Current (exact SHA ' + sha + ') into versions/' + OLD +
        ' and rewrote db/blob/build paths to that home',
    });

    // 3. The real archived Server opens the archived state, not Current.
    const archivedCli = path.join(archive, 'bin/nession');
    const archivedEnv = installEnv({
      home: archive, installDir: current.installDir, runtimeDir: current.runtime,
    });
    const envForServer = { ...archivedEnv, NESSION_NO_UPDATE_CHECK: '1' };
    assertCliSucceeds(
      runBinary(archivedCli, ['server', 'start', '--config', archivedConfig], envForServer),
      'start the archived Server',
    );
    try {
      await waitForTcp(port);
      assert.ok(
        fs.existsSync(path.join(archive, 'server/server.db')),
        'the archived Server did not create/use the archived database',
      );
      assert.ok(
        !fs.existsSync(path.join(current.home, 'server/server.db')),
        'the archived Server created a database under Current',
      );
      evidence.push({
        type: 'runtime',
        value: 'archived Server PID ' + readPid(current.runtime) +
          ' created versions/' + OLD + '/server/server.db and no Current database',
      });
    } finally {
      assertCliSucceeds(
        runBinary(archivedCli, ['server', 'stop'], envForServer),
        'stop the archived Server',
      );
    }

    // 4. An explicit external path is not rewritten.
    const external = generatedHome(base, 'external');
    const externalDir = mkdirPrivate(path.join(base, 'external-state'));
    fs.writeFileSync(path.join(external.home, 'server-config.toml'), [
      'listen_address = "127.0.0.1:19091"',
      'db_path = "' + path.join(externalDir, 'server.db') + '"',
      'image_blob_dir = "' + path.join(externalDir, 'blobs') + '"',
      'image_build_dir = "' + path.join(externalDir, 'build') + '"',
      '',
    ].join('\n'));
    await install(external, server.base, 'install external');
    const externalArchive = path.join(external.home, 'versions', OLD, 'server-config.toml');
    assert.equal(tomlString(externalArchive, 'db_path'), path.join(externalDir, 'server.db'));
    assert.equal(
      tomlString(externalArchive, 'image_blob_dir'),
      path.join(externalDir, 'blobs'),
    );
    evidence.push({
      type: 'runtime',
      value: 'explicit external db/image paths stayed verbatim in the archived config',
    });

    // 5. An in-home custom path refuses the archive and leaves Current intact.
    const unsafe = generatedHome(base, 'unsafe');
    const unsafeCustom = path.join(unsafe.home, 'server', 'custom.db');
    fs.mkdirSync(path.dirname(unsafeCustom), { recursive: true });
    fs.writeFileSync(path.join(unsafe.home, 'server-config.toml'), [
      'listen_address = "127.0.0.1:19092"',
      'db_path = "' + unsafeCustom + '"',
      '',
    ].join('\n'));
    const refused = await runCliAsync(
      ['install', TARGET, '--yes'],
      { ...unsafe.env, NESSION_UPDATE_API_URL: server.base },
      90_000,
      'refuse an in-home custom db_path',
    );
    assert.notEqual(refused.status, 0, 'a custom in-home db_path must refuse the archive');
    const refusedOutput = String(refused.stdout) + String(refused.stderr);
    assert.match(refusedOutput, /inside the Current home/);
    assert.ok(
      !fs.existsSync(path.join(unsafe.home, 'versions', OLD)),
      'a refused archive must not appear as a release',
    );
    assert.ok(
      !fs.existsSync(path.join(unsafe.home, '.install-transaction.json')),
      'a refused archive left a transaction journal',
    );
    evidence.push({
      type: 'runtime',
      value: 'an in-home custom db_path refused the archive with an explicit diagnostic; no release or journal was created',
    });
  } finally {
    await server.close();
  }

  return {
    summary: 'Real Current config defaults resolve inside the archived release home; explicit '
      + 'external paths survive; unsafe paths refuse (exact SHA ' + sha + ')',
    evidence,
  };
});

function readPid(runtimeDir) {
  try {
    return String(readIdentity(path.join(runtimeDir, 'server.pid')).pid);
  } catch {
    return 'unknown';
  }
}
