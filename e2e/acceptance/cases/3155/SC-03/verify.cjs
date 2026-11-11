'use strict';
// SC-03: a live legacy home-relative daemon avoids a duplicate start and stays
// discoverable/manageable by status/stop/restart; stale, reused or unprovable
// legacy records never cause an unrelated process to be signalled, and a live
// runtime identity is never clobbered.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate, runtimeEnv,
  runCli, assertCliSucceeds, spawnOrphaned, daemonLogs, waitFor, waitForGone,
  isRunning, freePort, waitForTcp, serverConfig, readIdentity, writeIdentity,
  main,
} = require('../../../shared/runtime-directory-cases.cjs');

const BACKGROUND_PID = /Server started in background with PID (\d+)/;

function killIfRunning(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

async function startLegacyForeground(env, config, legacyState, logDir) {
  const started = spawnOrphaned(
    ['server', 'start', '--config', config, '--foreground', '--pid-file', legacyState],
    env,
    logDir,
  );
  await waitFor(() => fs.existsSync(legacyState), 20000, 'the legacy PID file');
  return started;
}

async function waitForDaemonGone(started) {
  try {
    await waitForGone(started.pid, 20000, 'the legacy daemon to exit');
  } catch (error) {
    throw new Error(error.message + '\n' + daemonLogs(started));
  }
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc03');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = path.join(base, 'runtime');
  const xdg = mkdirPrivate(path.join(base, 'xdg'));
  const legacyState = path.join(home, 'server', 'server.pid');
  const runtimeState = path.join(runtime, 'server.pid');
  const serverPort = await freePort();
  const config = serverConfig(path.join(base, 'config'), serverPort);
  const env = runtimeEnv({ home, runtimeDir: runtime, xdgBase: xdg });

  // 1. A live legacy identity is status-visible, blocks a duplicate start, and
  //    is manageable by stop.
  const legacy = await startLegacyForeground(env, config, legacyState, base);
  try {
    await waitForTcp(serverPort);
    assert.equal(readIdentity(legacyState).pid, legacy.pid);

    const status = assertCliSucceeds(runCli(['server', 'status'], env), 'status with a live legacy daemon');
    assert.match(status.stdout, /Status: running/);
    assert.match(status.stdout, new RegExp('PID: ' + legacy.pid + '\\b'));
    assert.match(status.stdout, /legacy location/);
    assert.ok(status.stdout.includes(legacyState), 'status must name the legacy response file: ' + status.stdout);

    const duplicate = runCli(['server', 'start', '--config', config], env, 60000);
    assert.notEqual(duplicate.status, 0, 'a live legacy daemon must prevent a duplicate start');
    assert.match(String(duplicate.stderr) + String(duplicate.stdout),
      new RegExp('already running with PID ' + legacy.pid));
    assert.ok(isRunning(legacy.pid), 'the legacy daemon must survive the refused start');
    assert.ok(!fs.existsSync(runtimeState), 'the refused start must not create a runtime identity');
    evidence.push({
      type: 'runtime',
      value: 'live legacy daemon PID ' + legacy.pid + ' at ' + legacyState +
        ': status reported running/legacy location and a second start was refused without creating ' +
        runtimeState,
    });

    const stopped = assertCliSucceeds(runCli(['server', 'stop'], env), 'stop a live legacy daemon');
    assert.match(stopped.stdout, /Using legacy state file/);
    assert.match(stopped.stdout, /Server stopped successfully/);
    await waitForDaemonGone(legacy);
    assert.ok(!fs.existsSync(legacyState), 'stop must remove the legacy state file it verified');
    assert.ok(!fs.existsSync(runtimeState), 'stop must not invent a runtime identity');
    evidence.push({
      type: 'runtime',
      value: 'stop migrated by verified legacy identity: PID ' + legacy.pid +
        ' exited and ' + legacyState + ' was removed',
    });
  } finally {
    killIfRunning(legacy.pid);
  }

  // 2. Restart of a live legacy daemon stops it and writes the runtime identity.
  const legacyForRestart = await startLegacyForeground(env, config, legacyState, base);
  try {
    await waitForTcp(serverPort);
    const restart = assertCliSucceeds(
      runCli(['server', 'restart', '--config', config], env, 60000), 'restart a live legacy daemon');
    const announced = BACKGROUND_PID.exec(restart.stdout);
    assert.ok(announced, 'restart must report its serving PID: ' + restart.stdout);
    const newPid = Number(announced[1]);
    assert.notEqual(newPid, legacyForRestart.pid, 'restart must produce a new process');
    assert.ok(!isRunning(legacyForRestart.pid), 'the legacy process must be gone after restart');
    assert.ok(!fs.existsSync(legacyState), 'restart must remove the legacy state file');
    assert.equal(readIdentity(runtimeState).pid, newPid);
    assertCliSucceeds(runCli(['server', 'stop'], env), 'stop the restarted server');
    evidence.push({
      type: 'runtime',
      value: 'restart migrated legacy PID ' + legacyForRestart.pid + ' to runtime PID ' +
        newPid + ' recorded at ' + runtimeState + ' and removed the legacy file',
    });
  } finally {
    killIfRunning(legacyForRestart.pid);
  }

  // 3. A reused legacy pid — alive, but a different instance — is never
  //    signalled and its record is kept.
  {
    const now = Math.floor(Date.now() / 1000);
    writeIdentity(legacyState, { pid: process.pid, startedAt: now - 3600, kind: 'server' });
    const result = assertCliSucceeds(runCli(['server', 'stop'], env), 'stop with a reused legacy pid');
    assert.match(result.stdout, /is running but is not this Server/);
    assert.ok(isRunning(process.pid), 'the unrelated process behind the reused pid must survive');
    assert.ok(fs.existsSync(legacyState), 'a reused legacy record must not be discarded');
    assert.ok(!fs.existsSync(runtimeState), 'no runtime identity may be invented');
    evidence.push({
      type: 'runtime',
      value: 'reused legacy pid ' + process.pid + ' (wrong start time) was reported and not signalled; ' +
        'the record was left in place',
    });
    fs.rmSync(legacyState, { force: true });
  }

  // 4. A bare pid is not ownership evidence: no signal, record retained.
  {
    fs.mkdirSync(path.dirname(legacyState), { recursive: true });
    fs.writeFileSync(legacyState, String(process.pid));
    const result = assertCliSucceeds(runCli(['server', 'stop'], env), 'stop with a bare legacy pid');
    assert.match(result.stdout, /does not hold a verifiable Server identity/);
    assert.ok(isRunning(process.pid), 'a bare pid must never be signalled');
    assert.ok(fs.existsSync(legacyState), 'an unprovable legacy record must not be discarded');
    evidence.push({
      type: 'runtime',
      value: 'bare legacy pid ' + process.pid + ' was not treated as ownership evidence; ' +
        'no process was signalled and the record was retained',
    });
    fs.rmSync(legacyState, { force: true });
  }

  // 5. A stale legacy record is cleaned, not signalled.
  {
    writeIdentity(legacyState, {
      pid: 999_999_999,
      startedAt: Math.floor(Date.now() / 1000) - 3600,
      kind: 'server',
    });
    const status = assertCliSucceeds(runCli(['server', 'status'], env), 'status with a stale legacy record');
    assert.match(status.stdout, /Status: stopped \(process not running\)/);
    assert.ok(!fs.existsSync(legacyState), 'a stale legacy record is dead state and is removed');
    evidence.push({
      type: 'runtime',
      value: 'stale legacy record (pid 999999999) reported stopped and removed without a signal',
    });
  }

  // 6. An already-live runtime identity is never clobbered by a second start.
  {
    const first = assertCliSucceeds(
      runCli(['server', 'start', '--config', config], env, 60000), 'first runtime-directory start');
    const announced = BACKGROUND_PID.exec(first.stdout);
    assert.ok(announced, 'the first start must report its PID: ' + first.stdout);
    const livePid = Number(announced[1]);
    const before = readIdentity(runtimeState);

    const second = runCli(['server', 'start', '--config', config], env, 60000);
    assert.notEqual(second.status, 0, 'a live runtime identity must refuse a second start');
    assert.match(String(second.stderr) + String(second.stdout),
      new RegExp('already running with PID ' + livePid));
    assert.deepEqual(readIdentity(runtimeState), before, 'the live identity must be unchanged');
    assert.ok(isRunning(livePid), 'the live runtime process must survive the refused start');
    assertCliSucceeds(runCli(['server', 'stop'], env), 'stop the live runtime process');
    assert.ok(!fs.existsSync(runtimeState));
    evidence.push({
      type: 'runtime',
      value: 'live runtime identity PID ' + livePid + ' rejected a second start and remained unchanged',
    });
  }

  return {
    summary: 'Valid legacy daemons avoid double-start and stay manageable; reused/unprovable records ' +
      'are never signalled or discarded; live runtime identities are never clobbered (exact SHA ' + sha + ')',
    evidence,
  };
});
