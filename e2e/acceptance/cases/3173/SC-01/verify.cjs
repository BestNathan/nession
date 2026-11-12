'use strict';
// SC-01: install/archive semantics.
//
// Current starts at 1.1.0 in a fake managed install. Installing 0.35.0 must
// only create versions/0.35.0; installing 1.2.0 must archive 1.1.0 (binaries,
// configuration, durable state) and become Current. Reinstalls are idempotent,
// checksum failures and a live service leave Current untouched, and install.sh
// delegates versioned installs to the CLI's archive rule.
const {
  assert, fs, path, root, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, spawnOrphaned, waitFor, waitForGone,
  freePort, waitForTcp, serverConfig, writeFakeInstall, makeReleaseTarball,
  startReleaseServer, installEnv, cliOutput, runCliAsync, main,
} = require('../../../shared/release-version-cases.cjs');

const CURRENT = '1.1.0';
const OLD = '0.35.0';
const NEW = '1.2.0';
const BLOCKED = '1.3.0';
const BAD = '0.34.0';

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc01-install');
  const home = mkdirPrivate(path.join(base, 'home'));
  const installDir = path.join(base, 'install');
  const runtime = path.join(base, 'runtime');
  writeFakeInstall(installDir, CURRENT);
  fs.writeFileSync(path.join(home, 'agent-config.toml'), 'old-agent-config\n');
  fs.writeFileSync(path.join(home, 'server-config.toml'), 'old-server-config\n');
  fs.mkdirSync(path.join(home, 'server'), { recursive: true });
  fs.writeFileSync(path.join(home, 'server', 'server.db'), 'old-db\n');

  const releases = {};
  for (const version of [OLD, NEW, BLOCKED, BAD]) {
    releases[version] = makeReleaseTarball(base, version);
  }
  releases[BAD].badChecksum = true;
  const releaseServer = await startReleaseServer(releases);
  const env = installEnv({
    home,
    installDir,
    apiBase: releaseServer.base,
    runtimeDir: runtime,
  });
  const deadEnv = installEnv({ home, installDir, apiBase: 'http://127.0.0.1:1', runtimeDir: runtime });

  try {
    // 1. Older release: archive only, Current and its state untouched.
    const older = await runCliAsync(['install', OLD], env);
    assert.equal(older.status, 0, older.stderr);
    assert.match(older.stdout, /Installed release 0\.35\.0/);
    assert.match(older.stdout, /Current was not changed/);
    assert.ok(fs.readFileSync(path.join(installDir, 'nession'), 'utf8').includes('nession 1.1.0'));
    const archivedOld = path.join(home, 'versions', OLD, 'bin', 'nession');
    assert.ok(fs.readFileSync(archivedOld, 'utf8').includes('nession 0.35.0'));
    assert.equal(fs.readFileSync(path.join(home, 'agent-config.toml'), 'utf8'), 'old-agent-config\n');
    assert.equal(fs.readFileSync(path.join(home, 'server', 'server.db'), 'utf8'), 'old-db\n');
    evidence.push({
      type: 'runtime',
      value: 'install ' + OLD + ' archived only: Current stayed 1.1.0 and home config/server.db were unchanged',
    });

    // 2. Newer release: archive Current (binaries + config + durable state) and
    //    become Current with no inherited state.
    const newer = await runCliAsync(['install', NEW], env);
    assert.equal(newer.status, 0, newer.stderr);
    assert.match(newer.stdout, /Current is now release 1\.2\.0/);
    assert.ok(fs.readFileSync(path.join(installDir, 'nession'), 'utf8').includes('nession 1.2.0'));
    const archive = path.join(home, 'versions', CURRENT);
    assert.ok(fs.readFileSync(path.join(archive, 'bin', 'nession'), 'utf8').includes('nession 1.1.0'));
    assert.equal(fs.readFileSync(path.join(archive, 'agent-config.toml'), 'utf8'), 'old-agent-config\n');
    assert.equal(fs.readFileSync(path.join(archive, 'server-config.toml'), 'utf8'), 'old-server-config\n');
    assert.equal(fs.readFileSync(path.join(archive, 'server', 'server.db'), 'utf8'), 'old-db\n');
    assert.ok(!fs.existsSync(path.join(home, 'agent-config.toml')),
      'the new Current must not silently inherit the old configuration');
    assert.ok(!fs.existsSync(path.join(home, 'server')),
      'the new Current must not silently reuse the old durable state');
    assert.ok(fs.existsSync(archivedOld), 'the older archive must survive the upgrade');
    evidence.push({
      type: 'runtime',
      value: 'install ' + NEW + ' archived ' + CURRENT + ' (binaries, both configs, server.db) into ' +
        archive + ', made the install directory 1.2.0 and left the 0.35.0 archive intact',
    });

    // 3. Idempotence: same Current and an already-archived release need no
    //    network and overwrite no user data.
    const marker = path.join(archive, 'user-marker.txt');
    fs.writeFileSync(marker, 'keep\n');
    const same = cliOutput(['install', NEW], deadEnv);
    assert.equal(same.status, 0, same.output);
    assert.match(same.output, /Already at release 1\.2\.0/);
    const again = cliOutput(['install', CURRENT], deadEnv);
    assert.equal(again.status, 0, again.output);
    assert.match(again.output, /already archived/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep\n',
      'reinstalling an archived version must not overwrite user data');
    evidence.push({
      type: 'runtime',
      value: 'reinstalling Current (' + NEW + ') and archived ' + CURRENT +
        ' were offline no-ops; the archive user marker survived',
    });

    // 4. Checksum failure changes nothing.
    const bad = await runCliAsync(['install', BAD], env);
    assert.notEqual(bad.status, 0, bad.stderr);
    assert.match(String(bad.stdout) + String(bad.stderr), /Checksum mismatch/);
    assert.ok(fs.readFileSync(path.join(installDir, 'nession'), 'utf8').includes('nession 1.2.0'));
    assert.ok(!fs.existsSync(path.join(home, 'versions', BAD)),
      'a failed checksum must not leave an archive');
    evidence.push({
      type: 'runtime',
      value: 'checksum failure for ' + BAD + ' exited ' + bad.status +
        ', left Current 1.2.0 and created no archive',
    });

    // 5. Invalid/unsupported versions are rejected before any mutation.
    const invalid = await runCliAsync(['install', 'not-a-version'], env);
    assert.notEqual(invalid.status, 0);
    assert.match(String(invalid.stdout) + String(invalid.stderr), /invalid release version/);
    assert.ok(fs.readFileSync(path.join(installDir, 'nession'), 'utf8').includes('nession 1.2.0'));
    evidence.push({
      type: 'runtime',
      value: 'invalid version input exited ' + invalid.status + ' with an invalid release version error',
    });

    // 6. A live component blocks a Current replacement: moving its config and
    //    durable state is never done behind a running process.
    const serverHome = mkdirPrivate(path.join(base, 'server-home'));
    const serverPort = await freePort();
    const serverConfigFile = serverConfig(path.join(base, 'server-config'), serverPort);
    const serverEnv = installEnv({
      home: serverHome,
      installDir,
      apiBase: releaseServer.base,
      runtimeDir: runtime,
    });
    const server = spawnOrphaned(
      ['server', 'start', '--config', serverConfigFile, '--foreground'], serverEnv, base);
    try {
      await waitFor(() => fs.existsSync(path.join(runtime, 'server.pid')), 20000, 'server.pid');
      await waitForTcp(serverPort);
      const blocked = await runCliAsync(['install', BLOCKED], env);
      const blockedText = String(blocked.stdout) + String(blocked.stderr);
      assert.notEqual(blocked.status, 0, blockedText);
      assert.match(blockedText, /is running \(PID/);
      assert.match(blockedText, /never stops or restarts a service implicitly/);
      assert.ok(fs.readFileSync(path.join(installDir, 'nession'), 'utf8').includes('nession 1.2.0'));
      assert.ok(!fs.existsSync(path.join(home, 'versions', BLOCKED)));
      evidence.push({
        type: 'runtime',
        value: 'a live server (PID ' + server.pid + ') refused the ' + BLOCKED +
          ' Current replacement; Current 1.2.0 and its state were untouched',
      });
    } finally {
      try { process.kill(server.pid, 'SIGKILL'); } catch { /* gone */ }
      await waitForGone(server.pid, 10000, 'the blocking server').catch(() => {});
    }

    // 7. install.sh delegates versioned installs to the installed CLI.
    const fakeBin = mkdirPrivate(path.join(base, 'fake-bin'));
    const log = path.join(base, 'install-sh.log');
    fs.writeFileSync(path.join(fakeBin, 'nession'),
      '#!/bin/sh\necho "$@" >> ' + log + '\nexit 0\n', { mode: 0o755 });
    const sh = require('node:child_process').spawnSync(
      'sh',
      [path.join(root, 'scripts/install.sh'), '--version', OLD],
      { encoding: 'utf8', env: { ...env, PATH: fakeBin + ':' + env.PATH }, timeout: 30000 },
    );
    assert.equal(sh.status, 0, 'stdout=' + sh.stdout + ' stderr=' + sh.stderr);
    assert.ok(
      fs.existsSync(log),
      'install.sh did not delegate. stdout=' + sh.stdout + ' stderr=' + sh.stderr +
        ' fakeBin=' + fs.readdirSync(fakeBin).join(','),
    );
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp('install ' + OLD.replaceAll('.', '\\.')));
    evidence.push({
      type: 'runtime',
      value: 'scripts/install.sh --version ' + OLD + ' delegated to `nession install ' + OLD +
        '` through the installed CLI',
    });

    return {
      summary: 'Install archives older releases, archives Current before a newer install, is ' +
        'idempotent, fails closed on checksum/live-state and install.sh delegates (exact SHA ' + sha + ')',
      evidence,
    };
  } finally {
    await releaseServer.close();
  }
});
