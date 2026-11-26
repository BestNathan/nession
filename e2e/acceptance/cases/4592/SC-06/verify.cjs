'use strict';
// SC-06 (#4592): the first safe upgrade from a REAL published old CLI.
//
// v1.0.0 is the dangerous combination: it supports `install` (so the old
// `install --help` probe would delegate to it) but executes the superseded
// move-based transaction and does not advertise the upgrade contract. The
// merged-SHA scripts/install.sh must refuse that delegation, download and
// hash-verify the target, and let the verified TARGET transaction perform the
// upgrade — retaining config/identity/business state at Current.
//
// Also proven: the new CLI's install uses the same owner (same-version no-op),
// a corrupted checksum is refused, a fresh bootstrap still works, and an
// unknown version fails closed.
const { spawnSync } = require('node:child_process');
const {
  assert, fs, path, root, targetSha, nessionBin, makeRoot, mkdirPrivate,
  cliOutput, runBinary, waitFor, waitForTcp, installEnv, sha256File,
  makeRealReleaseTarball, startInstallerFixture, downloadOfficialRelease,
  BINARIES, main,
} = require('../../../shared/release-hardening-cases.cjs');

const OLD_VERSION = '1.0.0';

function runInstaller(script, args, env, timeout = 180000) {
  const result = spawnSync('sh', [script, ...args], {
    cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: String(result.stdout) + String(result.stderr) };
}

main(async () => {
  const sha = targetSha();
  const targetBin = nessionBin();
  const script = path.join(root, 'scripts', 'install.sh');
  const evidence = [];
  const base = makeRoot('4592-sc06');
  const home = mkdirPrivate(path.join(base, 'home'));
  const runtime = mkdirPrivate(path.join(base, 'runtime'));
  const installDir = mkdirPrivate(path.join(base, 'install'));

  // The real published old CLI: supports install, lacks the upgrade contract.
  const oldRelease = path.join(base, 'old-release');
  downloadOfficialRelease(OLD_VERSION, oldRelease);
  for (const binary of BINARIES) {
    const destination = path.join(installDir, binary);
    fs.copyFileSync(path.join(oldRelease, binary), destination);
    fs.chmodSync(destination, 0o755);
  }
  const oldCli = path.join(installDir, 'nession');
  const env = installEnv({ home, installDir, runtimeDir: runtime });
  const installHelp = runBinary(oldCli, ['install', '--help'], env, 30000);
  assert.equal(installHelp.status, 0, 'the old CLI must support install (the dangerous combination)');
  const oldContract = runBinary(oldCli, ['--upgrade-contract'], env, 30000);
  assert.notEqual(oldContract.status, 0, 'the old CLI must NOT advertise the upgrade contract');
  evidence.push({
    type: 'runtime',
    value: 'Official v' + OLD_VERSION + ' supports install but not the upgrade contract; ' +
      'the old install --help probe would have delegated to the move-based path',
  });

  const versionOutput = runBinary(targetBin, ['--version'], process.env, 30000);
  const targetVersion = String(versionOutput.stdout).trim().split(/\s+/).pop().replace(/^v/, '');

  // Configs, a persisted identity and a real Server DB at the Current home.
  const serverPort = await freePort();
  const agentConfigFile = path.join(home, 'agent-config.toml');
  const serverConfigFile = path.join(home, 'server-config.toml');
  const identityFile = path.join(home, 'agent', 'identity');
  const dbFile = path.join(home, 'server', 'server.db');
  fs.mkdirSync(path.join(home, 'server'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'agent'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(agentConfigFile, [
    'server_url = "ws://127.0.0.1:' + serverPort + '/ws"',
    'auth_token = ""',
    '',
  ].join('\n'));
  fs.writeFileSync(serverConfigFile, [
    'listen_address = "127.0.0.1:' + serverPort + '"',
    'tls_cert_path = ""',
    'tls_key_path = ""',
    'auth_token = ""',
    'db_path = "' + dbFile + '"',
    '',
  ].join('\n'));
  fs.writeFileSync(identityFile, 'agent-4592-sc06-identity\n');
  const serverStart = runBinary(oldCli, ['server', 'start'], env, 60000);
  assert.equal(serverStart.status, 0, 'old Server start: ' + serverStart.stdout + serverStart.stderr);
  await waitForTcp(serverPort);
  const serverStop = runBinary(oldCli, ['server', 'stop'], env, 60000);
  assert.equal(serverStop.status, 0, 'old Server stop: ' + serverStop.stdout + serverStop.stderr);
  await waitFor(() => !fs.existsSync(path.join(runtime, 'server.pid')), 15000, 'Server stopped');
  assert.ok(fs.existsSync(dbFile), 'the old Server did not create its database');

  const retained = { agentConfigFile, serverConfigFile, identityFile, dbFile };
  const before = {};
  for (const [label, file] of Object.entries(retained)) before[label] = sha256File(file);

  const release = makeRealReleaseTarball(base, targetVersion);
  let fixture = await startInstallerFixture(release);
  const installerEnv = {
    ...env,
    NESSION_RELEASE_BASE_URL: fixture.releaseBase,
    NESSION_UPDATE_API_URL: fixture.base,
  };
  delete installerEnv.GITHUB_TOKEN;
  delete installerEnv.GH_TOKEN;

  try {
    // 1. The fixed installer crosses the old CLI over to the new contract.
    const bridged = runInstaller(script, ['--version', targetVersion, '--dir', installDir], installerEnv);
    assert.equal(bridged.status, 0, 'install.sh bridge failed: ' + bridged.output.slice(-3000));
    assert.match(bridged.output, /verified target transaction/);
    assert.doesNotMatch(bridged.output, /Delegating to the installed nession CLI/);
    evidence.push({
      type: 'runtime',
      value: 'install.sh refused delegation to the move-based v' + OLD_VERSION +
        ' and upgraded through the verified target transaction (SHA ' + sha + ')',
    });

    // 2. Nothing was moved: config/identity/DB are byte-identical at Current.
    for (const [label, file] of Object.entries(retained)) {
      assert.equal(sha256File(file), before[label], label + ' was moved or rewritten by the upgrade');
    }
    const archive = path.join(home, 'versions', OLD_VERSION);
    assert.ok(fs.existsSync(path.join(archive, 'manifest.json')), 'the archive has no coverage manifest');
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8'));
    assert.equal(manifest.created_by, 'nession-upgrade-v1', 'the archive was not written by the new transaction');
    assert.equal(sha256File(path.join(archive, 'agent-config.toml')), before.agentConfigFile);
    assert.equal(sha256File(path.join(archive, 'server-config.toml')), before.serverConfigFile);
    assert.equal(fs.readFileSync(path.join(archive, 'agent', 'identity'), 'utf8').trim(), 'agent-4592-sc06-identity');
    assert.equal(sha256File(path.join(installDir, 'nession')), sha256File(targetBin), 'Current is not the verified target');
    assert.ok(!fs.existsSync(path.join(runtime, 'agent.pid')), 'the bridge auto-started an Agent');
    assert.ok(!fs.existsSync(path.join(runtime, 'server.pid')), 'the bridge auto-started a Server');
    evidence.push({
      type: 'runtime',
      value: 'Retention proven across the bridge: configs/identity/DB byte-identical at Current; ' +
        'archive v' + OLD_VERSION + ' holds independent copies and a nession-upgrade-v1 manifest',
    });

    // 3. The new CLI's install is the same owner: same version is a no-op.
    const noOp = cliOutput(['install', targetVersion, '--yes'], installerEnv, 120000);
    assert.equal(noOp.status, 0, 'new CLI install no-op failed: ' + noOp.output.slice(-2000));
    assert.match(noOp.output, /already installed/i);
    await fixture.close();
    fixture = null;

    // 4. Negative: a corrupted checksum is refused before anything is published.
    const badFixture = await startInstallerFixture({ ...release, checksum: '0'.repeat(64) });
    const freshDir = mkdirPrivate(path.join(base, 'fresh-bad'));
    const badEnv = {
      ...installEnv({ home: mkdirPrivate(path.join(base, 'home-bad')), runtimeDir: runtime }),
      NESSION_RELEASE_BASE_URL: badFixture.releaseBase,
      NESSION_UPDATE_API_URL: badFixture.base,
    };
    const bad = runInstaller(script, ['--version', targetVersion, '--dir', freshDir], badEnv);
    assert.notEqual(bad.status, 0, 'a corrupted checksum must be refused');
    assert.match(bad.output, /checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(freshDir, 'nession')), 'a corrupt release was published');
    await badFixture.close();
    evidence.push({ type: 'runtime', value: 'Corrupted checksum refused; nothing published' });

    // 5. Fresh bootstrap still works through the same verified path.
    const goodFixture = await startInstallerFixture(release);
    const freshGood = mkdirPrivate(path.join(base, 'fresh-good'));
    const goodEnv = {
      ...installEnv({ home: mkdirPrivate(path.join(base, 'home-good')), runtimeDir: runtime }),
      NESSION_RELEASE_BASE_URL: goodFixture.releaseBase,
      NESSION_UPDATE_API_URL: goodFixture.base,
    };
    const fresh = runInstaller(script, ['--version', targetVersion, '--dir', freshGood], goodEnv);
    assert.equal(fresh.status, 0, 'fresh bootstrap failed: ' + fresh.output.slice(-2000));
    for (const binary of BINARIES) {
      assert.ok(fs.existsSync(path.join(freshGood, binary)), 'fresh install missing ' + binary);
      assert.equal(sha256File(path.join(freshGood, binary)), sha256File(path.join(base, 'real-binaries-' + targetVersion, binary)));
    }
    evidence.push({ type: 'runtime', value: 'Fresh bootstrap installed all three verified binaries' });

    // 6. An unknown version fails closed.
    const unknown = runInstaller(script, ['--version', '99.99.99', '--dir', freshGood], goodEnv);
    assert.notEqual(unknown.status, 0, 'an unknown version must fail closed');
    await goodFixture.close();
    evidence.push({ type: 'runtime', value: 'Unknown version 99.99.99 refused by the installer' });

    return {
      summary: 'The real move-based v' + OLD_VERSION + ' CLI was crossed over by the fixed install.sh ' +
        'through the verified target transaction; config/identity/DB retained, same-owner no-op, ' +
        'checksum/fresh/unknown-version boundaries hold (exact SHA ' + sha + ')',
      evidence,
    };
  } finally {
    if (fixture) {
      try {
        await fixture.close();
      } catch (error) {
        evidence.push({ type: 'runtime', value: 'fixture close failed: ' + String(error).slice(-300) });
      }
    }
  }
});
