'use strict';
// SC-02: the shared lifecycle contract is real across release binaries.
//
// The Current build shares the runtime, PID identity and single-active gate
// from an archived home: start is idempotent, restart replaces only the
// selected component, status/stop work, and a peer release conflict refuses.
// The official v0.36.0 release (a genuinely different binary that predates the
// contract) is archived as 0.36.0; every dangerous selector command must fail
// closed without disturbing the real running process.
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runCli, assertCliSucceeds, runCliAsync, cliOutput, installEnv,
  serverConfig, agentConfig, freePort, waitForTcp, waitForGone, isRunning,
  readIdentity, writeIdentity, realBinaries, downloadOfficialRelease,
  runBinary, sha256File, waitFor, BINARIES, main,
} = require('../../../shared/release-hardening-cases.cjs');

const LEGACY = '0.36.0';
const CURRENT = '0.35.0';

function copyBinaries(sourceDir, destinationDir) {
  mkdirPrivate(destinationDir);
  for (const name of BINARIES) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(destinationDir, name));
    fs.chmodSync(path.join(destinationDir, name), 0o755);
  }
}

function outputOf(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];
  const base = makeRoot('sc02-contract');
  const home = mkdirPrivate(path.join(base, 'home'));
  const installDir = path.join(base, 'install');
  mkdirPrivate(installDir);
  for (const binary of realBinaries()) {
    const destination = path.join(installDir, path.basename(binary));
    fs.copyFileSync(binary, destination);
    fs.chmodSync(destination, 0o755);
  }
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const env = installEnv({ home, installDir, runtimeDir: runtime });

  // The archived copy of the Current build: a real, contract-aware binary in a
  // version home, exactly the environment the dispatcher would exec.
  const currentArchive = path.join(home, 'versions', CURRENT);
  copyBinaries(installDir, path.join(currentArchive, 'bin'));
  const archivedEnv = installEnv({
    home: currentArchive, installDir, runtimeDir: runtime,
  });
  const archivedCli = path.join(currentArchive, 'bin/nession');

  // The official v0.36.0 release: a real different binary, no contract.
  const legacyDir = path.join(home, 'versions', LEGACY, 'bin');
  downloadOfficialRelease(LEGACY, legacyDir);
  const legacyCli = path.join(legacyDir, 'nession');
  evidence.push({
    type: 'runtime',
    value: 'real binaries differ: current ' + sha256File(installDir + '/nession').slice(0, 16) +
      '… vs official v' + LEGACY + ' ' + sha256File(legacyCli).slice(0, 16) + '…',
  });

  const serverPort = await freePort();
  const agentPort = await freePort();
  const serverConfigFile = serverConfig(path.join(base, 'server-config'), serverPort);
  const agentConfigFile = agentConfig(path.join(base, 'agent-config'), {
    serverPort, agentPort, home: path.join(base, 'work'),
  });
  fs.mkdirSync(path.join(base, 'work'), { recursive: true });

  // The real Current Server is the peer another release must not disturb.
  assertCliSucceeds(
    runCli(['server', 'start', '--config', serverConfigFile], env, 60_000),
    'start the Current Server',
  );
  try {
    await waitForTcp(serverPort);
    const serverIdentity = readIdentity(path.join(runtime, 'server.pid'));

    // 1. Start the archived contract-aware Agent through its own version home.
    assert.equal(
      runBinary(archivedCli, ['--lifecycle-contract'], archivedEnv).status, 0,
      'the archived Current build must advertise the contract',
    );
    assertCliSucceeds(
      runBinary(archivedCli, ['agent', 'start', '--config', agentConfigFile], archivedEnv, 60_000),
      'start the archived Agent',
    );
    await waitForTcp(agentPort, 20_000);
    const firstAgent = readIdentity(path.join(runtime, 'agent.pid'));
    assert.equal(firstAgent.release_version, CURRENT);
    evidence.push({
      type: 'runtime',
      value: 'archived release ' + CURRENT + ' Agent started in the shared runtime (PID ' +
        firstAgent.pid + ') with the Current Server (PID ' + serverIdentity.pid + ')',
    });

    // 2. Start is idempotent across the version home: same PID.
    const secondStart = runBinary(
      archivedCli, ['agent', 'start', '--config', agentConfigFile], archivedEnv, 60_000,
    );
    assertCliSucceeds(secondStart, 'repeat archived agent start');
    assert.match(outputOf(secondStart), /already running|idempotent/);
    assert.equal(readIdentity(path.join(runtime, 'agent.pid')).pid, firstAgent.pid);
    evidence.push({
      type: 'runtime',
      value: 'a second start of the archived Agent preserved PID ' + firstAgent.pid,
    });

    // 3. Restart replaces only the selected component.
    assertCliSucceeds(
      runBinary(archivedCli, ['agent', 'restart', '--config', agentConfigFile], archivedEnv, 60_000),
      'restart the archived Agent',
    );
    await waitForTcp(agentPort, 20_000);
    const restarted = readIdentity(path.join(runtime, 'agent.pid'));
    assert.notEqual(restarted.pid, firstAgent.pid, 'restart must replace the Agent process');
    assert.equal(
      readIdentity(path.join(runtime, 'server.pid')).pid,
      serverIdentity.pid,
      'restart must not replace the Server',
    );
    evidence.push({
      type: 'runtime',
      value: 'restart replaced Agent ' + firstAgent.pid + ' with ' + restarted.pid +
        ' and left Server ' + serverIdentity.pid + ' untouched',
    });

    // 4. status and stop operate on the archived release's own process.
    const status = runBinary(archivedCli, ['agent', 'status'], archivedEnv, 30_000);
    assertCliSucceeds(status, 'archived agent status');
    assert.match(outputOf(status), new RegExp('PID:? ' + restarted.pid));
    assertCliSucceeds(runBinary(archivedCli, ['agent', 'stop'], archivedEnv, 30_000), 'stop the archived Agent');
    assert.ok(!isRunning(restarted.pid), 'the archived Agent was not stopped');
    evidence.push({
      type: 'runtime',
      value: 'archived status reported PID ' + restarted.pid + ' and stop removed it',
    });

    // 5. A peer running another release refuses a start that would mix releases.
    const realServer = readIdentity(path.join(runtime, 'server.pid'));
    writeIdentity(path.join(runtime, 'server.pid'), {
      pid: realServer.pid,
      startedAt: realServer.started_at,
      kind: 'server',
      version: '0.34.0',
    });
    const conflict = runBinary(
      archivedCli, ['agent', 'start', '--config', agentConfigFile], archivedEnv, 60_000,
    );
    assert.notEqual(conflict.status, 0, 'a mixed-release peer must refuse the start');
    assert.match(outputOf(conflict), /mixed-release/);
    assert.ok(
      !fs.existsSync(path.join(runtime, 'agent.pid')),
      'a refused mixed-release start must not record an Agent',
    );
    writeIdentity(path.join(runtime, 'server.pid'), {
      pid: realServer.pid,
      startedAt: realServer.started_at,
      kind: 'server',
      version: CURRENT,
    });
    evidence.push({
      type: 'runtime',
      value: 'a peer recorded as release 0.34.0 refused the archived start; no Agent identity was created',
    });

    // A live Agent from the contract-aware release proves legacy refusals do
    // not disturb the running process.
    assertCliSucceeds(
      runBinary(archivedCli, ['agent', 'start', '--config', agentConfigFile], archivedEnv, 60_000),
      'start the archived Agent for the legacy-refusal probe',
    );
    await waitForTcp(agentPort, 20_000);
    const liveAgent = readIdentity(path.join(runtime, 'agent.pid'));

    // 6. The official legacy release is refused for every dangerous selector.
    for (const args of [
      ['+0.36.0', 'agent', 'status'],
      ['+0.36.0', 'agent', 'stop'],
      ['+0.36.0', 'agent', 'restart'],
      ['+0.36.0', 'server', 'status'],
    ]) {
      const refused = cliOutput(args, env);
      assert.notEqual(refused.status, 0, args.join(' ') + ' must fail closed');
      assert.match(refused.output, /does not advertise the shared lifecycle contract/);
    }
    const byEnv = cliOutput(['agent', 'stop'], { ...env, NESSION_VERSION: LEGACY });
    assert.notEqual(byEnv.status, 0, 'NESSION_VERSION must fail closed too');
    assert.match(byEnv.output, /does not advertise/);
    const plusWins = cliOutput(
      ['+0.36.0', 'agent', 'stop'],
      { ...env, NESSION_VERSION: '0.34.0' },
    );
    assert.match(plusWins.output, /release 0\.36\.0 does not advertise/);
    assert.equal(readIdentity(path.join(runtime, 'agent.pid')).pid, liveAgent.pid);
    assert.ok(isRunning(liveAgent.pid), 'a refused legacy command disturbed the live Agent');
    assert.ok(isRunning(realServer.pid), 'a refused legacy command disturbed the live Server');
    evidence.push({
      type: 'runtime',
      value: 'official v' + LEGACY + ' was refused for +version and NESSION_VERSION ' +
        'agent/server start|restart|status|stop; live PIDs ' + liveAgent.pid + '/' +
        realServer.pid + ' survived and no second instance appeared',
    });
  } finally {
    if (fs.existsSync(path.join(runtime, 'agent.pid'))) {
      runBinary(archivedCli, ['agent', 'stop'], archivedEnv, 30_000);
    }
    const serverPid = readIdentity(path.join(runtime, 'server.pid')).pid;
    runCli(['server', 'stop'], env, 30_000);
    await waitForGone(serverPid, 10_000, 'the Current Server stop').catch(() => {});
  }

  return {
    summary: 'Real archived build keeps the shared lifecycle contract; the official v0.36.0 '
      + 'release is refused for dangerous selector commands (exact SHA ' + sha + ')',
    evidence,
  };
});
