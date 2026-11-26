'use strict';
// SC-02 (#4592): stop -> upgrade -> start continuity with REAL release binaries.
//
// The official v1.0.0 release (move-based transaction, pre-upgrade-contract) is
// installed as Current in an isolated home/install/runtime. A real old Server
// and Agent run, mint the persisted identity and create a Session. After a
// bounded stop, the merged-SHA target CLI upgrades the installation through the
// retention transaction. The Case then proves:
//   - both TOML configs, the identity, the Server DB and the Claude/ENV binding
//     records stay byte-for-byte at their Current paths (archive gets copies);
//   - nothing auto-restarts;
//   - the NEW Server/Agent start on the same home and the Session/identity
//     business state is still readable (no re-initialization).
const {
  assert, fs, path, targetSha, nessionBin, makeRoot, mkdirPrivate,
  cliOutput, runBinary, waitFor, waitForTcp, waitForGone,
  freePort, installEnv, readIdentity, sha256File, makeRealReleaseTarball,
  startInstallerFixture, downloadOfficialRelease, BINARIES, main,
} = require('../../../shared/release-hardening-cases.cjs');

const OLD_VERSION = '1.0.0';

function semverParts(version) {
  return String(version).replace(/^v/, '').split('.').map(Number);
}
function newerThan(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  }
  return false;
}

function fingerprint(files) {
  const out = {};
  for (const [label, file] of Object.entries(files)) {
    assert.ok(fs.existsSync(file), 'missing before upgrade: ' + file);
    out[label] = sha256File(file);
  }
  return out;
}

main(async () => {
  const sha = targetSha();
  const targetBin = nessionBin();
  const evidence = [];
  const base = makeRoot('4592-sc02');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const installDir = mkdirPrivate(path.join(base, 'install'));

  // The real published old release becomes Current (never a shell imitation).
  const oldRelease = path.join(base, 'old-release');
  downloadOfficialRelease(OLD_VERSION, oldRelease);
  for (const binary of BINARIES) {
    const destination = path.join(installDir, binary);
    fs.copyFileSync(path.join(oldRelease, binary), destination);
    fs.chmodSync(destination, 0o755);
  }
  const oldCli = path.join(installDir, 'nession');

  const versionOutput = runBinary(targetBin, ['--version'], process.env, 30000);
  const targetVersion = String(versionOutput.stdout).trim().split(/\s+/).pop().replace(/^v/, '');
  assert.ok(
    newerThan(targetVersion, OLD_VERSION),
    'the target build (' + targetVersion + ') must be newer than the old release ' + OLD_VERSION,
  );

  const env = installEnv({ home, installDir, runtimeDir: runtime });
  const serverPort = await freePort();
  const agentPort = await freePort();
  const workDir = mkdirPrivate(path.join(home, 'work'));

  // Configs live at the Current home's default paths. agent_id is deliberately
  // unset: the persisted identity file is the identity source under test.
  const serverConfigFile = path.join(home, 'server-config.toml');
  const dbFile = path.join(home, 'server', 'server.db');
  fs.mkdirSync(path.join(home, 'server'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(serverConfigFile, [
    'listen_address = "127.0.0.1:' + serverPort + '"',
    'tls_cert_path = ""',
    'tls_key_path = ""',
    'auth_token = ""',
    'db_path = "' + dbFile + '"',
    'heartbeat_timeout_secs = 120',
    '',
  ].join('\n'));
  const agentConfigFile = path.join(home, 'agent-config.toml');
  fs.writeFileSync(agentConfigFile, [
    'server_url = "ws://127.0.0.1:' + serverPort + '/ws"',
    'auth_token = ""',
    'listen_address = "127.0.0.1:' + agentPort + '"',
    'advertise_address = "127.0.0.1"',
    'disable_address_autodetect = true',
    'default_working_dir = "' + workDir + '"',
    '',
  ].join('\n'));

  // Claude/ENV binding records and a Server ENV record: owned durable subsets.
  const bindingFiles = {
    claude: path.join(home, 'agent', 'claude', 'settings.json'),
    agentEnvBinding: path.join(home, 'agent', 'env-bindings', 'binding.json'),
    serverEnv: path.join(home, 'server', 'envs', 'env.json'),
  };
  for (const [label, file] of Object.entries(bindingFiles)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ marker: '4592-' + label }) + '\n');
  }

  const identityFile = path.join(home, 'agent', 'identity');
  const files = {
    agentConfig: agentConfigFile,
    serverConfig: serverConfigFile,
    identity: identityFile,
    db: dbFile,
    ...bindingFiles,
  };

  let serverStarted = false;
  let agentStarted = false;
  let newServerStarted = false;
  let newAgentStarted = false;
  let fixture = null;
  try {
    // 1. Real old Server + Agent; the identity is minted and persisted.
    const serverStart = runBinary(oldCli, ['server', 'start'], env, 60000);
    assert.equal(serverStart.status, 0, 'old Server start: ' + serverStart.stdout + serverStart.stderr);
    serverStarted = true;
    await waitForTcp(serverPort);
    const agentStart = runBinary(oldCli, ['agent', 'start'], env, 60000);
    assert.equal(agentStart.status, 0, 'old Agent start: ' + agentStart.stdout + agentStart.stderr);
    agentStarted = true;
    await waitFor(() => fs.existsSync(identityFile), 20000, 'persisted Agent identity');
    const identityBefore = fs.readFileSync(identityFile, 'utf8').trim();
    assert.ok(identityBefore.length > 0, 'the old Agent minted an empty identity');
    await waitFor(() => fs.existsSync(path.join(runtime, 'agent.pid')), 10000, 'Agent runtime identity');
    const agentPid = readIdentity(path.join(runtime, 'agent.pid')).pid;

    // 2. A real Session through the old CLI: business state in the Server DB.
    // The client-side `agents`/`sessions` commands deliberately never borrow a
    // daemon config (#2267): they resolve `--server-url` > NESSION_SERVER_URL >
    // legacy alias > ws://127.0.0.1:8080, in v1.0.0 and today alike. The Case
    // must name the Server explicitly instead of relying on the daemon configs.
    const serverUrl = 'ws://127.0.0.1:' + serverPort + '/ws';
    const sessionName = 'continuity-4592';
    const create = runBinary(oldCli, [
      '--server-url', serverUrl, 'sessions', 'create',
      '--agent-id', identityBefore, '--name', sessionName,
    ], env, 60000);
    assert.equal(create.status, 0, 'old sessions create: ' + create.stdout + create.stderr);
    await waitFor(() => {
      const list = runBinary(oldCli, ['--server-url', serverUrl, 'sessions', 'list'], env, 30000);
      return list.status === 0 && String(list.stdout).includes(sessionName);
    }, 20000, 'Session visible through the old CLI');
    evidence.push({
      type: 'runtime',
      value: 'Official v' + OLD_VERSION + ' Server/Agent ran; identity ' + identityBefore +
        ' and Session ' + sessionName + ' created before the upgrade',
    });

    // 3. Bounded stop; fingerprints of everything that must survive.
    const agentStop = runBinary(oldCli, ['agent', 'stop'], env, 60000);
    assert.equal(agentStop.status, 0, 'old Agent stop: ' + agentStop.stdout + agentStop.stderr);
    await waitForGone(agentPid, 15000, 'old Agent exit');
    agentStarted = false;
    const serverStop = runBinary(oldCli, ['server', 'stop'], env, 60000);
    assert.equal(serverStop.status, 0, 'old Server stop: ' + serverStop.stdout + serverStop.stderr);
    serverStarted = false;
    await waitFor(() => !fs.existsSync(path.join(runtime, 'server.pid')), 15000, 'Server runtime identity gone');
    const before = fingerprint(files);

    // 4. Upgrade through the retention transaction (local verified fixture).
    const release = makeRealReleaseTarball(base, targetVersion);
    fixture = await startInstallerFixture(release);
    const upgradeEnv = installEnv({ home, installDir, runtimeDir: runtime, apiBase: fixture.base });
    const upgrade = cliOutput(['install', targetVersion, '--yes'], upgradeEnv, 180000);
    assert.equal(upgrade.status, 0, 'retention upgrade failed: ' + upgrade.output.slice(-3000));
    await fixture.close();
    fixture = null;
    evidence.push({
      type: 'runtime',
      value: 'Upgraded ' + OLD_VERSION + ' -> ' + targetVersion + ' through the target retention transaction (SHA ' + sha + ')',
    });

    // 5. Retention: every durable file is byte-for-byte at its Current path.
    const after = fingerprint(files);
    for (const label of Object.keys(before)) {
      assert.equal(after[label], before[label], label + ' changed at its Current path during the upgrade');
    }
    const archive = path.join(home, 'versions', OLD_VERSION);
    for (const binary of BINARIES) {
      assert.ok(fs.existsSync(path.join(archive, 'bin', binary)), 'archive missing ' + binary);
    }
    assert.ok(fs.existsSync(path.join(archive, 'manifest.json')), 'archive has no coverage manifest');
    assert.equal(sha256File(path.join(archive, 'agent-config.toml')), before.agentConfig, 'archive config copy differs');
    assert.equal(sha256File(path.join(archive, 'server-config.toml')), before.serverConfig, 'archive config copy differs');
    assert.equal(fs.readFileSync(path.join(archive, 'agent', 'identity'), 'utf8').trim(), identityBefore, 'archive identity copy differs');
    assert.ok(fs.existsSync(path.join(archive, 'server', 'server.db')), 'archive has no independent DB snapshot');
    evidence.push({
      type: 'runtime',
      value: 'Retention proven: configs/identity/DB/bindings byte-identical at Current; archive v' +
        OLD_VERSION + ' holds independent copies plus manifest.json',
    });

    // 6. No implicit restart: the upgrade never starts a daemon.
    assert.ok(!fs.existsSync(path.join(runtime, 'agent.pid')), 'the upgrade auto-started an Agent');
    assert.ok(!fs.existsSync(path.join(runtime, 'server.pid')), 'the upgrade auto-started a Server');

    // 7. The NEW Current starts on the same home; business state is continuous.
    const newCli = path.join(installDir, 'nession');
    assert.equal(sha256File(newCli), sha256File(targetBin), 'Current CLI is not the verified target binary');
    const newServer = runBinary(newCli, ['server', 'start'], env, 60000);
    assert.equal(newServer.status, 0, 'new Server start: ' + newServer.stdout + newServer.stderr);
    newServerStarted = true;
    await waitForTcp(serverPort);
    const newAgent = runBinary(newCli, ['agent', 'start'], env, 60000);
    assert.equal(newAgent.status, 0, 'new Agent start: ' + newAgent.stdout + newAgent.stderr);
    newAgentStarted = true;
    await waitFor(() => fs.existsSync(path.join(runtime, 'agent.pid')), 20000, 'new Agent runtime identity');
    const identityAfter = fs.readFileSync(identityFile, 'utf8').trim();
    assert.equal(identityAfter, identityBefore, 'the upgrade changed the persisted Agent identity');
    await waitFor(() => {
      const list = runBinary(newCli, ['--server-url', serverUrl, 'sessions', 'list'], env, 30000);
      return list.status === 0 && String(list.stdout).includes(sessionName);
    }, 30000, 'Session still visible through the new CLI');
    const finalList = runBinary(newCli, ['--server-url', serverUrl, 'sessions', 'list'], env, 30000);
    assert.ok(String(finalList.stdout).includes(identityBefore), 'the Session lost its Agent identity association');
    evidence.push({
      type: 'runtime',
      value: 'New Server/Agent started on the retained home; identity ' + identityAfter +
        ' and Session ' + sessionName + ' survived; no process auto-restarted',
    });

    return {
      summary: 'Real v' + OLD_VERSION + ' -> ' + targetVersion + ' stop/upgrade/start retained configs, ' +
        'identity, Server DB and bindings at their Current paths; Session business state is continuous ' +
        'and nothing auto-restarted (exact SHA ' + sha + ')',
      evidence,
    };
  } finally {
    const cleanupErrors = [];
    const stopWith = (cli, component, started) => {
      if (!started) return;
      try {
        const stop = runBinary(cli, [component, 'stop'], env, 60000);
        if (stop.status !== 0) cleanupErrors.push(component + ' stop: ' + String(stop.stderr).slice(-300));
      } catch (error) {
        cleanupErrors.push(component + ' stop: ' + String(error));
      }
    };
    stopWith(path.join(installDir, 'nession'), 'agent', newAgentStarted || agentStarted);
    stopWith(path.join(installDir, 'nession'), 'server', newServerStarted || serverStarted);
    if (fixture) {
      try { await fixture.close(); } catch (error) { cleanupErrors.push('fixture: ' + String(error)); }
    }
    if (cleanupErrors.length > 0) {
      evidence.push({ type: 'runtime', value: 'CLEANUP FAILED: ' + cleanupErrors.join('; ').slice(-1200) });
      throw new Error('SC-02 cleanup failed: ' + cleanupErrors.join('; '));
    }
  }
});
