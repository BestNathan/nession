'use strict';
// SC-03: lifecycle idempotence, cross-release conflict refusal, restart
// replacement, concurrency and legacy/reused-PID safety.
const { spawn } = require('node:child_process');
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, assertCliSucceeds, spawnCli, spawnOrphaned, waitFor, waitForGone,
  isRunning, freePort, waitForTcp, serverConfig, readIdentity, writeIdentity,
  installEnv, main,
} = require('../../../shared/release-version-cases.cjs');

const STARTED = /Server started in background with PID (\d+)/;

function waitExit(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve({ code: child.exitCode, output: child.output });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI did not exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output: child.output });
    });
  });
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];

  const base = makeRoot('sc03-lifecycle');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = path.join(base, 'runtime');
  const env = installEnv({ home, runtimeDir: runtime });
  const serverPort = await freePort();
  const config = serverConfig(path.join(base, 'config'), serverPort);
  const stateFile = path.join(runtime, 'server.pid');

  // 1. Start is idempotent: a second start with the same release succeeds and
  //    leaves the PID unchanged.
  const first = assertCliSucceeds(
    runCli(['server', 'start', '--config', config], env, 60_000), 'first start');
  const firstPid = Number(STARTED.exec(first.stdout)[1]);
  await waitForTcp(serverPort);
  const second = assertCliSucceeds(
    runCli(['server', 'start', '--config', config], env, 60_000), 'second start');
  assert.match(second.stdout, /already running/);
  assert.match(second.stdout, /start is idempotent/);
  assert.equal(readIdentity(stateFile).pid, firstPid);
  assert.ok(isRunning(firstPid), 'the original server must keep running');
  evidence.push({
    type: 'runtime',
    value: 'second start with the same release exited 0 with `already running`; PID ' +
      firstPid + ' was unchanged',
  });

  // 2. A peer from another release is a conflict, never an implicit restart.
  const identity = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(stateFile, identity.replace(/^version=.*$/m, 'version=9.9.9'));
  try {
    const conflict = runCli(['agent', 'start'], env, 60_000);
    assert.notEqual(conflict.status, 0, 'a mixed-release agent start must be refused');
    const conflictText = String(conflict.stderr) + String(conflict.stdout);
    assert.match(conflictText, /mixed-release environment/);
    assert.ok(isRunning(firstPid), 'the differently-versioned server must not be restarted');
    assert.ok(!fs.existsSync(path.join(runtime, 'agent.pid')),
      'the refused start must not create an agent identity');
  } finally {
    fs.writeFileSync(stateFile, identity);
  }
  evidence.push({
    type: 'runtime',
    value: 'agent start against a server recorded as release 9.9.9 was refused as a mixed-release ' +
      'environment; the server was not signalled and no agent state was written',
  });

  // 3. Restart replaces the process and records the selected release.
  const restarted = assertCliSucceeds(
    runCli(['server', 'restart', '--config', config], env, 60_000), 'restart');
  const restartedPid = Number(STARTED.exec(restarted.stdout)[1]);
  assert.notEqual(restartedPid, firstPid, 'restart must replace the process');
  assert.ok(!isRunning(firstPid), 'the pre-restart process must be gone');
  assert.equal(readIdentity(stateFile).pid, restartedPid);
  assert.equal(readIdentity(stateFile).release_version, '0.35.0');
  await waitForTcp(serverPort);
  evidence.push({
    type: 'runtime',
    value: 'restart replaced PID ' + firstPid + ' with ' + restartedPid +
      ' and recorded release 0.35.0',
  });

  // 4. Concurrent starts are serialised: one starts, the other observes the
  //    identity, exactly one process exists.
  assertCliSucceeds(runCli(['server', 'stop'], env), 'stop before the concurrency check');
  await waitForGone(restartedPid, 20000, 'the stopped server');
  const racers = [
    spawnCli(['server', 'start', '--config', config], env),
    spawnCli(['server', 'start', '--config', config], env),
  ];
  const [racerA, racerB] = await Promise.all(racers.map((child) => waitExit(child)));
  assert.equal(racerA.code, 0, racerA.output);
  assert.equal(racerB.code, 0, racerB.output);
  const joined = racerA.output + racerB.output;
  assert.equal((joined.match(/Server started in background with PID/g) || []).length, 1,
    'exactly one concurrent start may spawn a server: ' + joined);
  assert.equal((joined.match(/already running/g) || []).length, 1,
    'the other concurrent start must observe the running server: ' + joined);
  const concurrentPid = readIdentity(stateFile).pid;
  assert.ok(isRunning(concurrentPid), 'the single concurrent server must be running');
  evidence.push({
    type: 'runtime',
    value: 'two concurrent background starts produced one `Server started` and one ' +
      '`already running`; the recorded PID ' + concurrentPid + ' is alive',
  });
  assertCliSucceeds(runCli(['server', 'stop'], env), 'stop after the concurrency check');
  await waitForGone(concurrentPid, 20000, 'the concurrent server');

  // 5. A reused PID is never signalled.
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const now = Math.floor(Date.now() / 1000);
    writeIdentity(stateFile, {
      pid: sleeper.pid,
      startedAt: now - 3600,
      kind: 'server',
      version: '0.35.0',
    });
    const reused = assertCliSucceeds(runCli(['server', 'stop'], env), 'stop with a reused pid');
    assert.match(reused.stdout, /is running but is not this Server/);
    assert.ok(isRunning(sleeper.pid), 'an unrelated process behind a reused pid must survive');
    // The runtime location is this CLI's own state and is cleaned when it is
    // not ours; the safety property is that the reused process is not signalled.
    evidence.push({
      type: 'runtime',
      value: 'a reused PID (' + sleeper.pid + ') was reported and not signalled by stop',
    });
  } finally {
    sleeper.kill('SIGKILL');
    fs.rmSync(stateFile, { force: true });
  }

  // 6. A legacy foreground daemon is discovered by the default location and
  //    restart migrates it to the shared runtime identity.
  const legacyState = path.join(home, 'server', 'server.pid');
  const legacy = spawnOrphaned(
    ['server', 'start', '--config', config, '--foreground', '--pid-file', legacyState],
    env,
    base,
  );
  try {
    await waitFor(() => fs.existsSync(legacyState), 20000, 'the legacy state file');
    await waitForTcp(serverPort);
    const status = assertCliSucceeds(runCli(['server', 'status'], env), 'status of the legacy daemon');
    assert.match(status.stdout, /Status: running/);
    assert.match(status.stdout, /legacy location/);
    const migrated = assertCliSucceeds(
      runCli(['server', 'restart', '--config', config], env, 60_000), 'restart from legacy');
    const migratedPid = Number(STARTED.exec(migrated.stdout)[1]);
    assert.notEqual(migratedPid, legacy.pid);
    assert.ok(!isRunning(legacy.pid), 'the legacy process must be stopped by restart');
    assert.ok(!fs.existsSync(legacyState), 'restart must remove the legacy record');
    assert.equal(readIdentity(stateFile).pid, migratedPid);
    evidence.push({
      type: 'runtime',
      value: 'legacy foreground PID ' + legacy.pid + ' was found by default status and restart ' +
        'migrated it to runtime PID ' + migratedPid,
    });
    assertCliSucceeds(runCli(['server', 'stop'], env), 'stop the migrated server');
  } finally {
    try { process.kill(legacy.pid, 'SIGKILL'); } catch { /* gone */ }
    await waitForGone(legacy.pid, 10000, 'the legacy daemon').catch(() => {});
  }

  return {
    summary: 'Start idempotence, mixed-release refusal without peer restart, restart replacement, ' +
      'concurrent single-start, reused-PID safety and legacy migration (exact SHA ' + sha + ')',
    evidence,
  };
});
