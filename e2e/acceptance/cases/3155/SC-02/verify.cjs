'use strict';
// SC-02: Agent/Server start, stop, restart and status — foreground, background
// child and READY marker — consistently use the runtime PID files. An explicit
// --pid-file still overrides; the runtime directory is private and
// reboot-recreatable.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate, runtimeEnv,
  runCli, assertCliSucceeds, spawnOrphaned, daemonLogs, waitForGone, waitFor,
  isRunning, freePort, waitForTcp, serverConfig, agentConfig, readIdentity,
  assertPrivateDirectory, runtimeArtifacts, main,
} = require('../../../shared/runtime-directory-cases.cjs');

const PID_PATTERN = (label) => new RegExp(label + ' started in background with PID (\\d+)');

function killIfRunning(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc02');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = path.join(base, 'runtime');
  const xdg = mkdirPrivate(path.join(base, 'xdg'));
  const serverPort = await freePort();
  const config = serverConfig(path.join(base, 'config'), serverPort);
  const env = runtimeEnv({ home, runtimeDir: runtime, xdgBase: xdg });
  env.NESSION_TMUX_SOCKET = path.join(base, 'tmux.sock');
  const stateFile = path.join(runtime, 'server.pid');

  // 1. Foreground start writes the identity the CLI acts on, in the private
  //    runtime directory; status reports it and stop removes it.
  const foreground = spawnOrphaned(
    ['server', 'start', '--config', config, '--foreground'], env, base);
  try {
    await waitFor(() => fs.existsSync(stateFile), 20000, 'the foreground runtime PID file');
    assertPrivateDirectory(runtime);
    const identity = readIdentity(stateFile);
    assert.equal(identity.pid, foreground.pid, 'the identity must name the foreground process');
    assert.equal(identity.kind, 'server');
    await waitForTcp(serverPort);

    const running = assertCliSucceeds(runCli(['server', 'status'], env), 'server status');
    assert.match(running.stdout, /Status: running/);
    assert.match(running.stdout, new RegExp('PID: ' + foreground.pid + '\\b'));

    const stopped = assertCliSucceeds(runCli(['server', 'stop'], env), 'server stop');
    assert.match(stopped.stdout, /Server stopped successfully/);
    await waitForGone(foreground.pid, 20000, 'the foreground server to exit');
    assert.ok(!fs.existsSync(stateFile), 'stop must remove the runtime state file');
    const afterStop = assertCliSucceeds(runCli(['server', 'status'], env), 'server status after stop');
    assert.match(afterStop.stdout, /Status: stopped/);
    evidence.push({
      type: 'runtime',
      value: 'foreground: server.pid at ' + stateFile + ' named the serving PID ' +
        identity.pid + '; status=running; stop exited the process and removed the file',
    });
  } finally {
    killIfRunning(foreground.pid);
  }

  // 2. Background start returns only after the child announces READY, records
  //    the reported PID, and leaves no readiness/staging debris.
  const background = assertCliSucceeds(
    runCli(['server', 'start', '--config', config], env, 60000), 'background server start');
  const announced = PID_PATTERN('Server').exec(background.stdout);
  assert.ok(announced, 'background start must report its serving PID: ' + background.stdout);
  const backgroundPid = Number(announced[1]);
  assert.equal(readIdentity(stateFile).pid, backgroundPid,
    'the reported PID must be the recorded identity that stop/status will act on');
  await waitForTcp(serverPort);
  await waitFor(
    () => runtimeArtifacts(runtime).every((name) => !name.includes('.ready.') && !name.endsWith('.tmp')),
    10000,
    'the READY marker and its staging file to be removed',
  );
  evidence.push({
    type: 'runtime',
    value: 'background start reported PID ' + backgroundPid + ', the identity at ' + stateFile +
      ' matched it, and the READY marker/staging file were removed',
  });

  // 3. Restart replaces the process and the identity; the old PID is gone.
  const restart = assertCliSucceeds(
    runCli(['server', 'restart', '--config', config], env, 60000), 'server restart');
  const restarted = PID_PATTERN('Server').exec(restart.stdout);
  assert.ok(restarted, 'restart must report its serving PID: ' + restart.stdout);
  const restartPid = Number(restarted[1]);
  assert.notEqual(restartPid, backgroundPid, 'restart must produce a new process');
  assert.ok(!isRunning(backgroundPid), 'the pre-restart process must be gone');
  assert.equal(readIdentity(stateFile).pid, restartPid);
  assertCliSucceeds(runCli(['server', 'stop'], env), 'server stop after restart');
  assert.ok(!isRunning(restartPid), 'stop must terminate the restarted process');
  assert.ok(!fs.existsSync(stateFile), 'stop must remove the restarted state file');
  evidence.push({
    type: 'runtime',
    value: 'restart replaced PID ' + backgroundPid + ' with ' + restartPid +
      '; the old process was gone and stop removed the new state file',
  });

  // 4. Explicit --pid-file remains authoritative even when the runtime root is
  //    unavailable in this environment.
  const customDir = mkdirPrivate(path.join(base, 'custom'));
  const customPid = path.join(customDir, 'server.pid');
  const customPort = await freePort();
  const customConfig = serverConfig(path.join(base, 'custom-config'), customPort);
  const noRuntimeRoot = runtimeEnv({ home });
  const custom = spawnOrphaned(
    ['server', 'start', '--config', customConfig, '--foreground', '--pid-file', customPid],
    noRuntimeRoot,
    base,
  );
  try {
    await waitFor(() => fs.existsSync(customPid), 20000, 'the explicit --pid-file');
    assertPrivateDirectory(customDir);
    assert.ok(!fs.existsSync(stateFile), 'an explicit --pid-file must not also write the runtime path');
    await waitForTcp(customPort);
    const customStatus = assertCliSucceeds(
      runCli(['server', 'status', '--pid-file', customPid], noRuntimeRoot), 'status with --pid-file');
    assert.match(customStatus.stdout, /Status: running/);
    assert.match(customStatus.stdout, new RegExp('PID: ' + custom.pid + '\\b'));
    assertCliSucceeds(runCli(['server', 'stop', '--pid-file', customPid], noRuntimeRoot),
      'stop with --pid-file');
    await waitForGone(custom.pid, 20000, 'the explicit-state-file server to exit');
    assert.ok(!fs.existsSync(customPid), 'stop must remove the explicit state file');
    evidence.push({
      type: 'runtime',
      value: 'explicit --pid-file at ' + customPid + ' was the only state file used by ' +
        'start/status/stop, with no runtime-root resolution required',
    });
  } finally {
    killIfRunning(custom.pid);
  }

  // 5. The Agent path uses the same runtime state file and lifecycle.
  assertCliSucceeds(runCli(['server', 'start', '--config', config], env, 60000),
    'server start for the agent lifecycle');
  const agentState = path.join(runtime, 'agent.pid');
  const agentPort = await freePort();
  const agentCfg = agentConfig(path.join(base, 'agent-config'), {
    serverPort,
    agentPort,
    home,
  });
  try {
    const agentStart = assertCliSucceeds(
      runCli(['agent', 'start', '--config', agentCfg], env, 60000), 'agent start');
    const agentAnnounced = PID_PATTERN('Agent').exec(agentStart.stdout);
    assert.ok(agentAnnounced, 'agent start must report its serving PID: ' + agentStart.stdout);
    const agentPid = Number(agentAnnounced[1]);
    assert.equal(readIdentity(agentState).pid, agentPid);
    assertPrivateDirectory(runtime);
    const agentStatus = assertCliSucceeds(runCli(['agent', 'status'], env), 'agent status');
    assert.match(agentStatus.stdout, /Status: running/);
    assert.match(agentStatus.stdout, new RegExp('PID: ' + agentPid + '\\b'));
    const agentStop = assertCliSucceeds(runCli(['agent', 'stop'], env), 'agent stop');
    assert.match(agentStop.stdout, /Agent stopped successfully/);
    assert.ok(!fs.existsSync(agentState), 'agent stop must remove the agent state file');
    evidence.push({
      type: 'runtime',
      value: 'agent: start reported PID ' + agentPid + ' recorded at ' + agentState +
        ', status=running, stop exited it and removed the state file',
    });
  } finally {
    assertCliSucceeds(runCli(['server', 'stop'], env), 'server stop after the agent lifecycle');
  }

  return {
    summary: 'Foreground/background start, READY, status, stop and restart share the runtime ' +
      'PID files for Agent and Server; explicit --pid-file stays authoritative (exact SHA ' + sha + ')',
    evidence,
  };
});
