'use strict';
// SC-04: durable state compatibility and cross-release process discovery.
//
// A Current replacement archives the old configuration/database and leaves the
// new Current without them (no silent reuse). An archived release's CLI finds
// the same live process through the shared runtime directory and can stop and
// restart it. The generated service-manager contract keeps the shared PID file
// and runtime directory; a native boot-time service proof is not claimed.
const { spawnSync } = require('node:child_process');
const {
  assert, fs, path, root, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, assertCliSucceeds, spawnOrphaned, waitFor, waitForGone,
  freePort, waitForTcp, serverConfig, writeFakeInstall, makeReleaseTarball,
  startReleaseServer, installEnv, readIdentity, runCliAsync, main,
} = require('../../../shared/release-version-cases.cjs');

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc04-state');
  const home = mkdirPrivate(path.join(base, 'home'));
  const installDir = path.join(base, 'install');
  const runtime = path.join(base, 'runtime');
  writeFakeInstall(installDir, '1.1.0');
  fs.writeFileSync(path.join(home, 'agent-config.toml'), 'old-agent-config\n');
  fs.mkdirSync(path.join(home, 'server'), { recursive: true });
  fs.writeFileSync(path.join(home, 'server', 'server.db'), 'old-db\n');

  const release = makeReleaseTarball(base, '1.2.0');
  const releaseServer = await startReleaseServer({ '1.2.0': release });
  const env = installEnv({ home, installDir, apiBase: releaseServer.base, runtimeDir: runtime });
  try {
    const upgrade = await runCliAsync(['install', '1.2.0'], env);
    assert.equal(upgrade.status, 0, upgrade.stderr);
    const archive = path.join(home, 'versions', '1.1.0');
    assert.equal(fs.readFileSync(path.join(archive, 'agent-config.toml'), 'utf8'),
      'old-agent-config\n');
    assert.equal(fs.readFileSync(path.join(archive, 'server', 'server.db'), 'utf8'), 'old-db\n');
    assert.ok(!fs.existsSync(path.join(home, 'agent-config.toml')),
      'the new Current must not silently load the old config');
    assert.ok(!fs.existsSync(path.join(home, 'server')),
      'the new Current must not silently reuse the old database');
    evidence.push({
      type: 'runtime',
      value: 'upgrade archived the old config and database under versions/1.1.0; the new Current ' +
        'home has neither, so no incompatible state is silently reused',
    });

    // An archived release's CLI observes and manages the live process through
    // the shared runtime directory.
    const liveHome = mkdirPrivate(path.join(base, 'live-home'));
    const serverPort = await freePort();
    const config = serverConfig(path.join(base, 'server-config'), serverPort);
    const liveEnv = installEnv({ home: liveHome, installDir, runtimeDir: runtime });
    assertCliSucceeds(runCli(['server', 'start', '--config', config], liveEnv, 60_000),
      'start the live server');
    let pid = 0;
    try {
      await waitForTcp(serverPort);
      pid = readIdentity(path.join(runtime, 'server.pid')).pid;
      const archivedHome = mkdirPrivate(path.join(home, 'versions', '0.35.0'));
      // The archived CLI's durable home is the version home; process state is
      // the one shared runtime directory.
      const archivedEnv = installEnv({
        home: archivedHome,
        installDir,
        runtimeDir: runtime,
      });
      const status = assertCliSucceeds(
        runCli(['server', 'status'], archivedEnv), 'archived status');
      assert.match(status.stdout, /Status: running/);
      assert.match(status.stdout, new RegExp('PID: ' + pid + '\\b'));

      const stopped = assertCliSucceeds(
        runCli(['server', 'stop'], archivedEnv), 'archived stop');
      assert.match(stopped.stdout, /Server stopped successfully/);
      await waitForGone(pid, 20000, 'the server stopped by the archived CLI');

      const started = assertCliSucceeds(
        runCli(['server', 'start', '--config', config], archivedEnv, 60_000),
        'archived start');
      assert.match(started.stdout, /Server started in background/);
      pid = readIdentity(path.join(runtime, 'server.pid')).pid;
      assert.equal(readIdentity(path.join(runtime, 'server.pid')).release_version, '0.35.0');
      assert.ok(fs.existsSync(path.join(archivedHome, 'server')),
        'the archived release writes its durable state into its version home');
      assertCliSucceeds(runCli(['server', 'stop'], archivedEnv), 'archived stop after start');
      evidence.push({
        type: 'runtime',
        value: 'an archived release home found the live PID ' + pid +
          ' through the shared runtime, stopped it, and started a new process whose identity ' +
          'records release 0.35.0 with durable state under versions/0.35.0',
      });
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      await waitForGone(pid, 10000, 'the state-compat server').catch(() => {});
    }

    // Generated service-manager contract: the unit/plist pins the shared PID
    // file and runtime directory. Native boot-time execution is deliberately
    // not claimed by this Case.
    const testName = process.platform === 'darwin'
      ? 'the_launchd_plist_forwards_config_and_pid_file_with_valid_escaping'
      : 'the_systemd_unit_forwards_config_and_pid_file';
    const test = spawnSync(
      'cargo',
      ['test', '-p', 'nession-cli', '--lib', 'service::tests::' + testName],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 110_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, RUSTC_WRAPPER: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
      },
    );
    assert.equal(test.status, 0, String(test.stderr || test.stdout).slice(-3500));
    assert.ok(String(test.stdout).includes(testName + ' ... ok'),
      'the generated service contract test must actually run: ' + test.stdout);
    evidence.push({
      type: 'runtime',
      value: 'generated ' + (process.platform === 'darwin' ? 'launchd plist' : 'systemd unit') +
        ' contract test passed: --pid-file and NESSION_RUNTIME_DIR are pinned (native boot ' +
        'execution not claimed)',
    });

    return {
      summary: 'Durable config/DB separation across releases, archived-release discovery through ' +
        'the shared runtime, and pinned service contract (exact SHA ' + sha + ')',
      evidence,
    };
  } finally {
    await releaseServer.close();
  }
});
