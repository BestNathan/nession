'use strict';
// SC-01: the runtime root resolves per OS, NESSION_RUNTIME_DIR wins with a
// validated absolute path, NESSION_HOME cannot redirect process state, and an
// unsafe or unavailable environment errors instead of falling back.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate, runtimeEnv,
  runCli, assertCliSucceeds, spawnOrphaned, daemonLogs, waitForGone, waitFor,
  freePort, serverConfig, readIdentity, assertPrivateDirectory, main,
} = require('../../../shared/runtime-directory-cases.cjs');

function startForeground(env, configFile, logDir) {
  return spawnOrphaned(
    ['server', 'start', '--config', configFile, '--foreground'], env, logDir);
}

async function stopForeground(started, env) {
  const stopped = runCli(['server', 'stop'], env);
  assertCliSucceeds(stopped, 'server stop');
  try {
    await waitForGone(started.pid, 20000, 'the foreground server to exit');
  } catch (error) {
    throw new Error(error.message + '\n' + daemonLogs(started));
  }
}

function killIfRunning(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  // The deterministic resolver rows — Linux user/root, Darwin, override,
  // relative override, unsafe root, permission tightening — are Rust tests in
  // the crate that owns resolution. Running them at the exact SHA proves every
  // row on this host, not only the row the host happens to be.
  const { checked } = require('../../../shared/control-mode-cases.cjs');
  const tests = checked('cargo', ['test', '-p', 'nession-common', '--lib', 'paths::tests::'], 90000);
  const expectedTests = [
    'the_runtime_override_is_used_verbatim',
    'a_relative_runtime_override_is_rejected',
    'a_linux_user_uses_the_xdg_runtime_directory',
    'linux_root_uses_the_system_runtime_directory',
    'a_linux_user_without_xdg_gets_an_actionable_error',
    'a_macos_user_uses_the_darwin_user_temporary_directory',
    'a_macos_user_without_a_user_temporary_directory_gets_an_actionable_error',
    'an_unsupported_platform_requires_the_override',
    'runtime_resolution_does_not_follow_nession_home',
    'ensure_creates_an_owner_private_runtime_directory',
    'ensure_tightens_an_existing_runtime_directory',
    'ensure_rejects_a_symlinked_runtime_directory',
    'a_group_writable_runtime_root_is_rejected',
  ];
  for (const name of expectedTests) {
    assert.ok(tests.includes(name + ' ... ok'), 'missing resolver assertion: ' + name);
  }
  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': ' + expectedTests.length +
      ' resolver/permission tests passed on ' + process.platform +
      ' (Linux user/root, Darwin, override, relative, no-XDG, symlink, group-writable)',
  });

  // 1. Absolute NESSION_RUNTIME_DIR: used verbatim, private, independent of
  //    NESSION_HOME.
  {
    const base = makeRoot('sc01-override');
    const home = mkdirPrivate(path.join(base, 'home'));
    const runtime = path.join(base, 'runtime');
    const xdg = mkdirPrivate(path.join(base, 'xdg'));
    const config = serverConfig(path.join(base, 'config'), await freePort());
    const port = Number(fs.readFileSync(config, 'utf8').match(/listen_address = "127\.0\.0\.1:(\d+)"/)[1]);
    const env = runtimeEnv({ home, runtimeDir: runtime, xdgBase: xdg });
    const started = startForeground(env, config, base);
    try {
      await waitFor(() => fs.existsSync(path.join(runtime, 'server.pid')), 20000, 'the runtime PID file');
      const identity = readIdentity(path.join(runtime, 'server.pid'));
      assert.equal(identity.pid, started.pid, 'the recorded identity must be the serving process');
      assertPrivateDirectory(runtime);
      assert.ok(!fs.existsSync(path.join(home, 'server', 'server.pid')),
        'the durable home must not receive the PID file');
      assert.ok(!fs.existsSync(path.join(home, 'agent', 'agent.pid')),
        'the durable home must not receive an agent PID file');
      await stopForeground(started, env);
      evidence.push({
        type: 'runtime',
        value: 'absolute NESSION_RUNTIME_DIR ' + runtime + ': server.pid at ' + runtime +
          '/server.pid, directory 0700 owned by uid ' + process.getuid() +
          ', nothing written under NESSION_HOME ' + home,
      });
    } finally {
      killIfRunning(started.pid);
    }
  }

  // 2. The platform default root: XDG on Linux, the Darwin per-user temporary
  //    directory on macOS.
  {
    const base = makeRoot('sc01-default');
    const home = mkdirPrivate(path.join(base, 'home'));
    const osRoot = mkdirPrivate(path.join(base, 'os-runtime'));
    const config = serverConfig(path.join(base, 'config'), await freePort());
    const port = Number(fs.readFileSync(config, 'utf8').match(/listen_address = "127\.0\.0\.1:(\d+)"/)[1]);
    const env = process.platform === 'darwin'
      ? runtimeEnv({ home, darwinBase: osRoot })
      : runtimeEnv({ home, xdgBase: osRoot });
    const expectedDir = path.join(osRoot, 'nession');
    const started = startForeground(env, config, base);
    try {
      await waitFor(() => fs.existsSync(path.join(expectedDir, 'server.pid')), 20000,
        'the default runtime PID file');
      assertPrivateDirectory(expectedDir);
      const identity = readIdentity(path.join(expectedDir, 'server.pid'));
      assert.equal(identity.pid, started.pid);
      await stopForeground(started, env);
      evidence.push({
        type: 'runtime',
        value: 'platform default (' + (process.platform === 'darwin'
          ? '_CS_DARWIN_USER_TEMP_DIR' : 'XDG_RUNTIME_DIR') + ') ' + osRoot +
          '/nession: server.pid exists there, directory 0700, NESSION_HOME ' + home + ' untouched',
      });
    } finally {
      killIfRunning(started.pid);
    }
  }

  // 3. A relative override is rejected — never resolved against the CWD.
  {
    const base = makeRoot('sc01-relative');
    const home = mkdirPrivate(path.join(base, 'home'));
    const env = runtimeEnv({ home, runtimeDir: 'relative/nession-runtime' });
    const result = runCli(['server', 'status'], env);
    assert.notEqual(result.status, 0, 'a relative NESSION_RUNTIME_DIR must fail');
    const message = String(result.stderr) + String(result.stdout);
    assert.match(message, /absolute/);
    assert.match(message, /NESSION_RUNTIME_DIR/);
    assert.ok(!fs.existsSync(path.join(base, 'relative')), 'no relative state directory may be created');
    evidence.push({
      type: 'runtime',
      value: 'relative NESSION_RUNTIME_DIR exited ' + result.status +
        ' with an actionable absolute-path error and created no relative state',
    });
  }

  // 4. A symlinked runtime directory is rejected, not followed.
  {
    const base = makeRoot('sc01-symlink');
    const home = mkdirPrivate(path.join(base, 'home'));
    const osRoot = mkdirPrivate(path.join(base, 'os-runtime'));
    const real = mkdirPrivate(path.join(base, 'elsewhere'));
    fs.symlinkSync(real, path.join(osRoot, 'nession'));
    const env = process.platform === 'darwin'
      ? runtimeEnv({ home, darwinBase: osRoot })
      : runtimeEnv({ home, xdgBase: osRoot });
    const result = runCli(['server', 'status'], env);
    assert.notEqual(result.status, 0, 'a symlinked runtime directory must fail');
    assert.match(String(result.stderr) + String(result.stdout), /symlink/);
    assert.equal(fs.statSync(real).mode & 0o777, 0o700,
      'the symlink target must not be treated as the runtime directory');
    evidence.push({
      type: 'runtime',
      value: 'symlinked runtime directory exited ' + result.status +
        ' naming the symlink; the target was not used as process state',
    });
  }

  // 5. A group/other-writable OS runtime root is rejected.
  {
    const base = makeRoot('sc01-shared-root');
    const home = mkdirPrivate(path.join(base, 'home'));
    const osRoot = mkdirPrivate(path.join(base, 'os-runtime'));
    fs.chmodSync(osRoot, 0o777);
    const env = process.platform === 'darwin'
      ? runtimeEnv({ home, darwinBase: osRoot })
      : runtimeEnv({ home, xdgBase: osRoot });
    const result = runCli(['server', 'status'], env);
    assert.notEqual(result.status, 0, 'a shared runtime root must fail');
    assert.match(String(result.stderr) + String(result.stdout), /writable by group or other/);
    evidence.push({
      type: 'runtime',
      value: 'group/other-writable runtime root exited ' + result.status +
        ' instead of placing PID state in a hijackable directory',
    });
  }

  // 6. Linux non-root without XDG_RUNTIME_DIR errors; it never falls back to
  //    the durable home. (Darwin always has a per-user temporary directory.)
  if (process.platform === 'linux' && process.getuid() !== 0) {
    const base = makeRoot('sc01-no-xdg');
    const home = mkdirPrivate(path.join(base, 'home'));
    const env = runtimeEnv({ home });
    delete env.XDG_RUNTIME_DIR;
    const result = runCli(['server', 'status'], env);
    assert.notEqual(result.status, 0, 'missing XDG_RUNTIME_DIR must fail for a non-root user');
    const message = String(result.stderr) + String(result.stdout);
    assert.match(message, /XDG_RUNTIME_DIR/);
    assert.match(message, /NESSION_RUNTIME_DIR/);
    assert.ok(!fs.existsSync(path.join(home, 'server', 'server.pid')),
      'no durable home fallback PID file may appear');
    assert.ok(!fs.existsSync(path.join(home, 'agent', 'agent.pid')),
      'no durable home fallback agent PID file may appear');
    evidence.push({
      type: 'runtime',
      value: 'Linux non-root without XDG_RUNTIME_DIR exited ' + result.status +
        ' requesting NESSION_RUNTIME_DIR; no durable-home or /tmp fallback state was written',
    });
  }

  return {
    summary: 'The runtime root follows the OS contract, the override is validated, and ' +
      'NESSION_HOME cannot redirect PID state (exact SHA ' + sha + ')',
    evidence,
  };
});
