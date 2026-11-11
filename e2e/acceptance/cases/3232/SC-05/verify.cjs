'use strict';
// SC-05: real manager ownership. No fixture unit/plist can satisfy this Case.
// The trusted, ephemeral native CI runner explicitly opts in; a local
// developer's unit/job is never created, stopped, or inspected destructively.
const { spawnSync } = require('node:child_process');
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  serverConfig, agentConfig, runCli, cliOutput, freePort, waitForTcp,
  waitFor, readIdentity, isRunning, downloadOfficialRelease,
} = require('../../../shared/release-hardening-cases.cjs');

const LABEL = 'com.nession.agent';
const UNIT = 'nession-agent.service';
function command(bin, args, env = process.env) {
  const run = spawnSync(bin, args, {
    env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error) throw run.error;
  return { code: run.status, output: (run.stdout || '') + (run.stderr || '') };
}
function requireCommand(bin, args, env, label) {
  const result = command(bin, args, env);
  assert.equal(result.code, 0, label + ': ' + result.output.slice(-1500));
  return result.output;
}
function systemdProperties(env) {
  const result = command('systemctl', [
    '--user', 'show', '--property=LoadState,ActiveState,MainPID', UNIT,
  ], env);
  const props = Object.fromEntries(result.output.split('\n')
    .filter((line) => /^[a-zA-Z]+=.*/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return {
    manager: 'systemd', available: result.code === 0,
    registered: props.LoadState === 'loaded',
    running: props.LoadState === 'loaded' && props.ActiveState === 'active',
    pid: Number(props.MainPID || 0),
    detail: result.output.trim().slice(0, 500),
  };
}
function launchdProperties(env) {
  const uid = process.getuid();
  for (const domain of ['gui', 'user']) {
    const target = domain + '/' + uid + '/' + LABEL;
    const result = command('launchctl', ['print', target], env);
    if (result.code !== 0) continue;
    const pid = Number((/^\s*pid = (\d+)\s*$/m.exec(result.output) || [])[1] || 0);
    return {
      manager: 'launchd', available: true, registered: true,
      running: /^\s*state = running\s*$/m.test(result.output) && pid > 0,
      pid, target, detail: result.output.slice(0, 500),
    };
  }
  return {
    manager: 'launchd', available: true, registered: false,
    running: false, pid: 0, detail: 'No launchd job registered',
  };
}
function observe(env) {
  return process.platform === 'darwin' ? launchdProperties(env) : systemdProperties(env);
}
function managerRestart(state, env) {
  if (process.platform === 'darwin') {
    assert.ok(state.target, 'real launchd domain required');
    requireCommand('launchctl', ['kickstart', '-k', state.target], env, 'launchd restart');
  } else {
    requireCommand('systemctl', ['--user', 'restart', UNIT], env, 'systemd restart');
  }
}
function managerStop(state, env) {
  if (process.platform === 'darwin') {
    if (state.target) command('launchctl', ['bootout', state.target], env);
  } else {
    command('systemctl', ['--user', 'disable', '--now', UNIT], env);
  }
}
function emit(status, summary, evidence) {
  process.stdout.write(JSON.stringify({ status, summary, evidence }) + '\n');
}
async function verify() {
  const evidence = [];
  if (!['linux', 'darwin'].includes(process.platform)) {
    return { status: 'pending', summary: 'A native Linux or macOS runner is required', evidence };
  }
  if (process.env.NESION_ACCEPTANCE_ISOLATED_SERVICE_MANAGER !== '1' ||
      process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
    return { status: 'pending',
      summary: 'Requires the approved isolated native Acceptance runner; no operator service was touched',
      evidence: [{ type: 'runtime', value: 'Isolation authorization missing' }] };
  }
  const base = makeRoot('3232-manager');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const env = { ...process.env, NESSION_HOME: home, NESSION_RUNTIME_DIR: runtime,
    NESSION_NO_UPDATE_CHECK: '1' };
  delete env.NESSION_VERSION;
  delete env.NESSION_VERSION_DISPATCHED;

  // The OS manager is a real host service, not controlled by HOME. Never touch
  // pre-existing user ownership even on a trusted CI runner.
  const initial = observe(env);
  evidence.push({ type: 'runtime', value: 'Native manager preflight: ' + initial.detail });
  if (!initial.available || initial.registered) {
    return { status: 'pending',
      summary: 'No available clean native user-manager service slot; existing service left untouched',
      evidence };
  }
  const servicePath = process.platform === 'darwin'
    ? path.join(env.HOME, 'Library', 'LaunchAgents', LABEL + '.plist')
    : path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'),
      'systemd', 'user', UNIT);
  if (fs.existsSync(servicePath)) {
    return { status: 'pending', summary: 'Operator-owned service file exists; refusal to mutate ' + servicePath,
      evidence };
  }
  const sha = targetSha();
  nessionBin();
  const serverPort = await freePort();
  const agentPort = await freePort();
  const serverCfg = serverConfig(path.join(base, 'server'), serverPort);
  const agentCfg = agentConfig(path.join(base, 'agent'), {
    serverPort, agentPort, home: mkdirPrivate(path.join(base, 'work')),
  });
  let installed = false;
  let serverStarted = false;
  let before = null;
  let error = null;
  try {
    const startServer = cliOutput(['server', 'start', '--config', serverCfg], env, 60000);
    assert.equal(startServer.status, 0, 'real Server start: ' + startServer.output);
    serverStarted = true;
    await waitForTcp(serverPort);
    const install = cliOutput(['agent', 'install-service', '--config', agentCfg], env, 60000);
    // Registration may exist even when the command reports a failed startup.
    installed = fs.existsSync(servicePath) || observe(env).registered;
    assert.equal(install.status, 0, 'real Agent service install: ' + install.output);
    await waitFor(() => {
      const state = observe(env);
      return state.running && state.pid > 0 && fs.existsSync(path.join(runtime, 'agent.pid'));
    }, 18000, 'native manager-owned Agent');
    before = observe(env);
    const identity = readIdentity(path.join(runtime, 'agent.pid'));
    assert.equal(identity.pid, before.pid, 'manager and Agent PID identity must agree');
    assert.ok(isRunning(before.pid), 'manager Agent must actually be alive');
    evidence.push({ type: 'runtime', value: before.manager + ' owns real Agent PID ' +
      before.pid + ', version ' + identity.release_version });

    // A real, independently published pre-contract release must fail closed
    // even while a service manager is keeping the Current Agent alive.
    // This covers the cross-version selector path without synthesizing an old
    // shell script or touching the manager's registered binary.
    const oldVersion = '0.36.0';
    const legacyBin = path.join(home, 'versions', oldVersion, 'bin');
    downloadOfficialRelease(oldVersion, legacyBin); // checksums.txt verified
    const legacy = cliOutput(['+' + oldVersion, 'agent', 'restart', '--config', agentCfg],
      env, 30000);
    assert.notEqual(legacy.status, 0, 'legacy cross-version restart must be refused');
    assert.match(legacy.output, /lifecycle|legacy|contract|unsupported/i);
    assert.equal(observe(env).pid, before.pid,
      'cross-version restart must not revive the historical manager binary');
    evidence.push({ type: 'runtime', value:
      'Real official v' + oldVersion + ' CLI cross-version restart refused; manager-owned PID ' +
      before.pid + ' was preserved' });

    const start = cliOutput(['agent', 'start', '--config', agentCfg], env, 30000);
    assert.equal(start.status, 0, 'managed Start must remain idempotent: ' + start.output);
    assert.match(start.output, /already running/i);
    for (const [action, args] of [
      ['stop', ['agent', 'stop']],
      ['restart', ['agent', 'restart', '--config', agentCfg]],
    ]) {
      const attempt = cliOutput(args, env, 30000);
      assert.notEqual(attempt.status, 0, 'managed CLI ' + action + ' must refuse');
      assert.match(attempt.output, /managed by (systemd|launchd)/i);
      const after = observe(env);
      assert.equal(after.pid, before.pid, 'CLI ' + action + ' changed the manager-owned PID');
      assert.ok(isRunning(before.pid), 'CLI ' + action + ' killed the manager-owned Agent');
      evidence.push({ type: 'runtime', value: 'CLI ' + action + ' refused; manager PID remained ' + before.pid });
    }

    managerRestart(before, env);
    await waitFor(() => {
      const next = observe(env);
      return next.running && next.pid > 0 && next.pid !== before.pid &&
        fs.existsSync(path.join(runtime, 'agent.pid')) &&
        readIdentity(path.join(runtime, 'agent.pid')).pid === next.pid;
    }, 20000, 'manager-controlled Agent restart');
    const after = observe(env);
    const newIdentity = readIdentity(path.join(runtime, 'agent.pid'));
    assert.equal(newIdentity.release_version, identity.release_version,
      'manager must not revive a different release');
    assert.equal(after.pid, newIdentity.pid);
    evidence.push({ type: 'runtime', value: 'Native manager restarted Agent PID ' +
      before.pid + ' -> ' + after.pid + '; release remained ' + newIdentity.release_version });
    return { status: 'pass',
      summary: 'Native ' + before.manager + ' owned the real Agent: CLI start idempotent, ' +
        'stop/restart refused, manager restart preserved release (exact SHA ' + sha + ')',
      evidence };
  } catch (caught) {
    error = caught;
    return { status: 'fail', summary: String(caught.stack || caught).slice(-3500), evidence };
  } finally {
    const cleanupErrors = [];
    if (installed) {
      try { managerStop(observe(env), env); } catch (e) { cleanupErrors.push(String(e)); }
      try {
        const uninstall = cliOutput(['agent', 'uninstall-service'], env, 30000);
        if (uninstall.status !== 0) cleanupErrors.push('uninstall: ' + uninstall.output.slice(-400));
      } catch (e) { cleanupErrors.push(String(e)); }
    }
    if (serverStarted) {
      try {
        const stop = cliOutput(['server', 'stop'], env, 30000);
        if (stop.status !== 0) cleanupErrors.push('server stop: ' + stop.output.slice(-400));
      } catch (e) { cleanupErrors.push(String(e)); }
    }
    if (cleanupErrors.length > 0) {
      // Cleanup failures are never suppressed as a successful proof.
      evidence.push({ type: 'runtime', value: 'CLEANUP FAILED: ' + cleanupErrors.join('; ').slice(-1200) });
      if (!error) throw Error('Native service cleanup failed: ' + cleanupErrors.join('; '));
    } else {
      evidence.push({ type: 'runtime', value: 'Only Case-owned service/runtime were torn down' });
    }
  }
}
verify().then((result) => emit(result.status, result.summary, result.evidence))
  .catch((error) => {
    emit('fail', String(error.stack || error).slice(-4400), [
      { type: 'runtime', value: 'Native service manager Case failed safely' },
    ]);
    process.exitCode = 1;
  });
