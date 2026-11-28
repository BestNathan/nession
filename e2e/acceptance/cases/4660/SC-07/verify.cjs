'use strict';
// SC-07 (#4660): the first safe upgrade from the REAL published v1.0.1 CLI
// through the candidate install.sh bridge, on isolated Agent-only (empty Server
// dirs) and Server-only (valid DB) fixtures. Proves the committed outcome is
// reported truthfully (no synthetic archive-directory requirement, no false
// rollback), the archive carries honest typed coverage, the asset transfers
// exactly once, and corrupted-artifact / live-writer negatives fail closed.
//
// Reuses the #4592 release-hardening lane (no new privileges). Native macOS
// readback is a separate supplemental prerequisite; this Linux record does not
// claim native proof.
const { spawn } = require('node:child_process');
const {
  assert, fs, path, root, targetSha, nessionBin, makeRoot, mkdirPrivate,
  runBinary, waitFor, waitForTcp, freePort, installEnv, sha256File, tomlString, assertUnder,
  makeRealReleaseTarball, startInstallerFixture, downloadOfficialRelease,
  BINARIES, main,
} = require('../../../shared/release-hardening-cases.cjs');

const OLD_VERSION = '1.0.1';

// The release fixture is served from this process; a synchronous spawn would
// starve its HTTP server. Run the installer asynchronously and collect output.
function runInstaller(script, args, env, timeout = 180000) {
  const child = spawn('sh', [script, ...args], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('installer did not exit within ' + timeout + 'ms'));
    }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, output: stdout + stderr });
    });
  });
}

function installerEnv(fixture, { home, installDir, runtimeDir, extra }) {
  const env = installEnv({ home, installDir, runtimeDir, extra });
  env.NESSION_RELEASE_BASE_URL = fixture.releaseBase;
  env.NESSION_UPDATE_API_URL = fixture.base;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  return env;
}

/** Install the real published old CLI into a fresh isolated install dir. */
function seedOldInstall(oldRelease, installDir) {
  for (const binary of BINARIES) {
    const destination = path.join(installDir, binary);
    fs.copyFileSync(path.join(oldRelease, binary), destination);
    fs.chmodSync(destination, 0o755);
  }
  return path.join(installDir, 'nession');
}

main(async () => {
  const sha = targetSha();
  const targetBin = nessionBin();
  const script = path.join(root, 'scripts', 'install.sh');
  const evidence = [];
  const base = makeRoot('4660-sc07');

  const oldRelease = path.join(base, 'old-release');
  downloadOfficialRelease(OLD_VERSION, oldRelease);
  const versionOutput = runBinary(targetBin, ['--version'], process.env, 30000);
  const targetVersion = String(versionOutput.stdout).trim().split(/\s+/).pop().replace(/^v/, '');
  const release = makeRealReleaseTarball(base, targetVersion);
  const fixture = await startInstallerFixture(release);

  try {
    // ── Variant A: Agent-only installation, empty Server dirs (the incident) ──
    const homeA = mkdirPrivate(path.join(base, 'home-agent-only'));
    const installA = mkdirPrivate(path.join(base, 'install-agent-only'));
    const runtimeA = mkdirPrivate(path.join(base, 'runtime-agent-only'));
    const oldCliA = seedOldInstall(oldRelease, installA);
    const envA = installerEnv(fixture, { home: homeA, installDir: installA, runtimeDir: runtimeA });
    const contractA = runBinary(oldCliA, ['--upgrade-contract'], envA, 30000);
    assert.notEqual(contractA.status, 0, 'published v' + OLD_VERSION + ' must NOT advertise the upgrade contract');

    // Agent config/identity/token + a redundant backup; Server tree holds only
    // images/{blobs,build} and logs (no server.db / server-config); empty EROFS.
    fs.writeFileSync(path.join(homeA, 'agent-config.toml'),
      'server_url = "ws://127.0.0.1:19098/ws"\nauth_token = ""\n');
    fs.mkdirSync(path.join(homeA, 'agent'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(homeA, 'agent/identity'), 'agent-4660-sc07-identity\n');
    fs.writeFileSync(path.join(homeA, 'agent-config.token'), 'fixture-token-not-a-real-secret\n', { mode: 0o600 });
    fs.writeFileSync(path.join(homeA, 'agent-config.toml.bak-20261127'), 'old-config\n');
    fs.mkdirSync(path.join(homeA, 'server/images/blobs'), { recursive: true });
    fs.mkdirSync(path.join(homeA, 'server/images/build'), { recursive: true });
    fs.mkdirSync(path.join(homeA, 'server/logs'), { recursive: true });
    fs.mkdirSync(path.join(homeA, 'erofs'), { recursive: true });
    const identityBefore = sha256File(path.join(homeA, 'agent/identity'));
    const configBefore = sha256File(path.join(homeA, 'agent-config.toml'));

    fixture.counts.asset = 0;
    const bridgedA = await runInstaller(script, ['--version', targetVersion, '--dir', installA], envA);
    assert.equal(bridgedA.status, 0, 'Agent-only bridge must exit 0 (the #4660 false-failure): ' + bridgedA.output.slice(-3000));
    assert.match(bridgedA.output, /nession-install-result-v1 outcome=committed result=ok/);
    assert.doesNotMatch(bridgedA.output, /was not snapshotted into the archive/);
    assert.equal(fixture.counts.asset, 1, 'exactly one full asset GET (first-hop handoff), got ' + fixture.counts.asset);
    const archiveA = path.join(homeA, 'versions', OLD_VERSION);
    const manifestA = JSON.parse(fs.readFileSync(path.join(archiveA, 'manifest.json'), 'utf8'));
    assert.equal(manifestA.schema, 2, 'schema-2 typed coverage manifest');
    assert.equal(manifestA.created_by, 'nession-upgrade-v1');
    assert.equal(manifestA.state_complete, true, 'Agent-only fixture must be state-complete: ' + JSON.stringify(manifestA.gaps));
    const classOf = (p) => (manifestA.coverage.find((e) => e.path === p) || {}).class;
    assert.equal(classOf('agent-config.token'), 'captured', 'Agent token captured privately');
    assert.equal(classOf('agent-config.toml.bak-20261127'), 'excluded', 'config backup excluded');
    assert.equal(classOf('server/server.db'), 'not_applicable', 'absent Server DB not_applicable');
    assert.equal(classOf('erofs'), 'referenced', 'empty EROFS referenced-safe');
    assert.ok(!manifestA.coverage.some((e) => e.class === 'missing' || e.class === 'unknown'),
      'no false missing/unknown coverage');
    // Retention + three binary hashes.
    assert.equal(sha256File(path.join(homeA, 'agent/identity')), identityBefore, 'identity retained');
    assert.equal(sha256File(path.join(homeA, 'agent-config.toml')), configBefore, 'agent config retained');
    assert.ok(fs.existsSync(path.join(homeA, 'agent-config.token')), 'token retained at Current');
    for (const binary of BINARIES) {
      assert.equal(sha256File(path.join(installA, binary)), sha256File(path.join(base, 'real-binaries-' + targetVersion, binary)),
        'Current ' + binary + ' is the verified target');
      assert.ok(fs.existsSync(path.join(archiveA, 'bin', binary)), 'archive missing ' + binary);
    }
    assert.ok(!fs.existsSync(path.join(runtimeA, 'agent.pid')), 'bridge auto-started an Agent');
    assert.ok(!fs.existsSync(path.join(runtimeA, 'server.pid')), 'bridge auto-started a Server');
    evidence.push({ type: 'runtime', value: 'Agent-only empty-Server bridge committed (exit 0), one asset GET, ' +
      'schema-2 coverage state-complete with no false missing; config/identity/token retained (SHA ' + sha + ')' });

    // ── Variant B: Server-only installation with a valid DB ──
    const homeB = mkdirPrivate(path.join(base, 'home-server-only'));
    const installB = mkdirPrivate(path.join(base, 'install-server-only'));
    const runtimeB = mkdirPrivate(path.join(base, 'runtime-server-only'));
    const oldCliB = seedOldInstall(oldRelease, installB);
    const envB = installerEnv(fixture, { home: homeB, installDir: installB, runtimeDir: runtimeB });
    const serverPort = await freePort();
    const dbFile = path.join(homeB, 'server', 'server.db');
    fs.mkdirSync(path.join(homeB, 'server'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(homeB, 'server-config.toml'),
      'listen_address = "127.0.0.1:' + serverPort + '"\ntls_cert_path = ""\ntls_key_path = ""\nauth_token = ""\ndb_path = "' + dbFile + '"\n');
    const startB = runBinary(oldCliB, ['server', 'start'], envB, 60000);
    assert.equal(startB.status, 0, 'old Server start: ' + startB.stdout + startB.stderr);
    await waitForTcp(serverPort);
    const stopB = runBinary(oldCliB, ['server', 'stop'], envB, 60000);
    assert.equal(stopB.status, 0, 'old Server stop: ' + stopB.stdout + stopB.stderr);
    await waitFor(() => !fs.existsSync(path.join(runtimeB, 'server.pid')), 15000, 'Server stopped');
    assert.ok(fs.existsSync(dbFile), 'old Server did not create its database');
    const dbBefore = sha256File(dbFile);

    fixture.counts.asset = 0;
    const bridgedB = await runInstaller(script, ['--version', targetVersion, '--dir', installB], envB);
    assert.equal(bridgedB.status, 0, 'Server-only bridge failed: ' + bridgedB.output.slice(-3000));
    assert.match(bridgedB.output, /nession-install-result-v1 outcome=committed result=ok/);
    assert.equal(fixture.counts.asset, 1, 'Server-only bridge transfers the asset once');
    assert.equal(sha256File(dbFile), dbBefore, 'Server DB retained byte-identical at Current');
    const archiveB = path.join(homeB, 'versions', OLD_VERSION);
    assert.ok(fs.existsSync(path.join(archiveB, 'server/server.db')), 'archive holds an independent DB snapshot');
    assertUnder(tomlString(path.join(archiveB, 'server-config.toml'), 'db_path'), archiveB, 'archive db_path');
    evidence.push({ type: 'runtime', value: 'Server-only valid-DB bridge committed; DB retained at Current and ' +
      'independently snapshotted into the archive; one asset GET (SHA ' + sha + ')' });

    // ── Negative: corrupted artifact refused, nothing published ──
    const badFixture = await startInstallerFixture({ ...release, checksum: '0'.repeat(64) });
    const freshBad = mkdirPrivate(path.join(base, 'fresh-bad'));
    const badEnv = installerEnv(badFixture, { home: mkdirPrivate(path.join(base, 'home-bad')), runtimeDir: runtimeA });
    const bad = await runInstaller(script, ['--version', targetVersion, '--dir', freshBad], badEnv);
    assert.notEqual(bad.status, 0, 'a corrupted checksum must be refused');
    assert.match(bad.output, /checksum mismatch/);
    assert.ok(!fs.existsSync(path.join(freshBad, 'nession')), 'a corrupt release was published');
    await badFixture.close();
    evidence.push({ type: 'runtime', value: 'Corrupted checksum refused; nothing published' });

    // ── Negative: live writer refused before download (zero asset GETs) ──
    const homeL = mkdirPrivate(path.join(base, 'home-live'));
    const installL = mkdirPrivate(path.join(base, 'install-live'));
    const runtimeL = mkdirPrivate(path.join(base, 'runtime-live'));
    const oldCliL = seedOldInstall(oldRelease, installL);
    const envL = installerEnv(fixture, { home: homeL, installDir: installL, runtimeDir: runtimeL });
    fs.writeFileSync(path.join(homeL, 'agent-config.toml'), 'server_url = "ws://127.0.0.1:19097/ws"\nauth_token = ""\n');
    const agentStart = runBinary(oldCliL, ['agent', 'start'], envL, 60000);
    assert.equal(agentStart.status, 0, 'old Agent start: ' + agentStart.stdout + agentStart.stderr);
    await waitFor(() => fs.existsSync(path.join(runtimeL, 'agent.pid')), 15000, 'Agent live');
    fixture.counts.asset = 0;
    const live = await runInstaller(script, ['--version', targetVersion, '--dir', installL], envL);
    assert.notEqual(live.status, 0, 'a live Agent must refuse the upgrade');
    assert.equal(fixture.counts.asset, 0, 'live-writer refusal spends zero asset GETs, got ' + fixture.counts.asset);
    assert.equal(sha256File(path.join(installL, 'nession')), sha256File(path.join(oldRelease, 'nession')),
      'Current unchanged on live-writer refusal');
    const agentStop = runBinary(oldCliL, ['agent', 'stop'], envL, 60000);
    assert.equal(agentStop.status, 0, 'old Agent stop: ' + agentStop.stdout + agentStop.stderr);
    evidence.push({ type: 'runtime', value: 'Live Agent refused before download with zero asset GETs; Current unchanged; ' +
      'no implicit stop/start by the bridge' });

    return {
      summary: 'The real published v' + OLD_VERSION + ' CLI was crossed over by the candidate install.sh ' +
        'on Agent-only (empty Server) and Server-only (valid DB) fixtures: committed outcome reported truthfully, ' +
        'honest schema-2 coverage, one asset transfer, retention proven; corrupted-artifact and live-writer ' +
        'negatives fail closed (exact SHA ' + sha + '). Native macOS readback: Pending (no approved native lane).',
      evidence,
    };
  } finally {
    try { await fixture.close(); } catch (error) {
      evidence.push({ type: 'runtime', value: 'fixture close failed: ' + String(error).slice(-300) });
    }
  }
});