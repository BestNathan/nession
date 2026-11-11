'use strict';
// SC-03: scripts/install.sh first migration, fresh bootstrap and failure safety.
//
// The old installation is the real official v0.36.0 release (it predates the
// versioned installer). The new release is a tarball of the real target
// binaries. A dual-layout fixture serves both the installer and the CLI's
// transaction, and every scenario runs the checked-in script.
const { spawn, execFileSync } = require('node:child_process');
const {
  assert, fs, path, root, targetSha, makeRoot, mkdirPrivate, nessionBin,
  runCli, realBinaryPath, sha256File, makeRealReleaseTarball,
  downloadOfficialRelease, startInstallerFixture, tomlString, assertUnder, main,
} = require('../../../shared/release-hardening-cases.cjs');

const TARGET = '1.2.0';
const LEGACY = '0.36.0';
const LEGACY_REPORTED = LEGACY;
const SCRIPT = path.join(root, 'scripts', 'install.sh');

function runInstaller(args, env, timeout = 110_000) {
  const child = spawn('sh', [SCRIPT, ...args], {
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
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, output: stdout + stderr });
    });
  });
}

function installerEnv(fixture, installDir, home, extra = {}) {
  return {
    ...process.env,
    NESSION_RELEASE_BASE_URL: fixture.releaseBase,
    NESSION_UPDATE_API_URL: fixture.base,
    NESSION_INSTALL_DIR: installDir,
    NESSION_HOME: home,
    HOME: home,
    NESSION_NO_UPDATE_CHECK: '1',
    ...extra,
  };
}

function hashes(directory) {
  const result = {};
  for (const name of ['nession', 'nession-agent', 'nession-server']) {
    result[name] = sha256File(path.join(directory, name));
  }
  return result;
}

function copyInstall(source, destination) {
  mkdirPrivate(destination);
  for (const name of ['nession', 'nession-agent', 'nession-server']) {
    const file = path.join(destination, name);
    fs.copyFileSync(path.join(source, name), file);
    fs.chmodSync(file, 0o755);
  }
  return destination;
}

function prepareHome(home) {
  mkdirPrivate(home);
  fs.mkdirSync(path.join(home, 'server'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(home, 'server/server.db'), 'legacy-db');
  fs.writeFileSync(path.join(home, 'agent/identity'), 'legacy-agent');
  fs.writeFileSync(path.join(home, 'server-config.toml'), [
    'listen_address = "127.0.0.1:19093"',
    'db_path = "' + path.join(home, 'server/server.db') + '"',
    'image_blob_dir = "' + path.join(home, 'server/images/blobs') + '"',
    'image_build_dir = "' + path.join(home, 'server/images/build') + '"',
    '',
  ].join('\n'));
}

async function scenario(fixture, installDir, home, extra = {}) {
  return runInstaller(
    ['--version', TARGET, '--dir', installDir],
    installerEnv(fixture, installDir, home, extra),
  );
}

main(async () => {
  const sha = targetSha();
  nessionBin();
  const evidence = [];
  const base = makeRoot('sc03-install');
  const release = makeRealReleaseTarball(base, TARGET);
  const payload = hashes(path.join(base, 'real-binaries-' + TARGET));
  const good = await startInstallerFixture({ version: TARGET, ...release });
  const legacySource = mkdirPrivate(path.join(base, 'legacy-source'));
  downloadOfficialRelease(LEGACY, legacySource);
  const legacyHashes = hashes(legacySource);

  try {
    // 1. A real pre-versioned install is archived, not overwritten.
    const migrationInstall = copyInstall(legacySource, path.join(base, 'migration-install'));
    const migrationHome = path.join(base, 'migration-home');
    prepareHome(migrationHome);
    const migrated = await scenario(good, migrationInstall, migrationHome, { NESSION_VERSION: LEGACY });
    assert.equal(migrated.status, 0, 'first migration failed: ' + migrated.output);
    assert.deepEqual(hashes(migrationInstall), payload, 'installed binaries are not the target release');
    const archive = path.join(migrationHome, 'versions', LEGACY_REPORTED);
    assert.ok(fs.existsSync(archive), 'the old release was not archived');
    assert.deepEqual(hashes(path.join(archive, 'bin')), legacyHashes, 'archived binaries are not the real old release');
    assert.equal(fs.readFileSync(path.join(archive, 'server/server.db'), 'utf8'), 'legacy-db');
    assert.equal(fs.readFileSync(path.join(archive, 'agent/identity'), 'utf8'), 'legacy-agent');
    for (const key of ['db_path', 'image_blob_dir', 'image_build_dir']) {
      assertUnder(tomlString(path.join(archive, 'server-config.toml'), key), archive, key);
    }
    assert.ok(!fs.existsSync(path.join(migrationHome, '.install-transaction.json')));
    evidence.push({
      type: 'runtime',
      value: 'official v' + LEGACY + ' install migrated: target binaries match the release, old binaries/config/DB/agent state live under versions/' + LEGACY_REPORTED,
    });

    // 2. A fresh machine still bootstraps normally.
    const freshInstall = path.join(base, 'fresh-install');
    const freshHome = mkdirPrivate(path.join(base, 'fresh-home'));
    const fresh = await scenario(good, freshInstall, freshHome);
    assert.equal(fresh.status, 0, 'fresh bootstrap failed: ' + fresh.output);
    assert.deepEqual(hashes(freshInstall), payload, 'fresh install binaries do not match');
    assert.ok(!fs.existsSync(path.join(freshHome, 'versions')), 'a fresh install created a version archive');
    evidence.push({
      type: 'runtime',
      value: 'fresh-machine bootstrap installed the same three verified binaries with no archive',
    });

    // 3. A checksum failure leaves the old installation byte-identical.
    const badInstall = copyInstall(legacySource, path.join(base, 'checksum-install'));
    const badHome = path.join(base, 'checksum-home');
    prepareHome(badHome);
    const badFixture = await startInstallerFixture({
      version: TARGET, assetName: release.assetName, tarball: release.tarball,
      checksum: '0'.repeat(64),
    });
    try {
      const before = hashes(badInstall);
      const bad = await scenario(badFixture, badInstall, badHome);
      assert.notEqual(bad.status, 0, 'a bad checksum must fail the install');
      assert.match(bad.output, /checksum mismatch/);
      assert.deepEqual(hashes(badInstall), before, 'a checksum failure changed the old binaries');
      assert.ok(!fs.existsSync(path.join(badHome, 'versions')));
    } finally {
      await badFixture.close();
    }
    evidence.push({
      type: 'runtime',
      value: 'a checksum mismatch stopped before publication; the old three binaries and home were unchanged',
    });

    // 4. A tarball missing one binary is refused before publication.
    const incompleteDir = mkdirPrivate(path.join(base, 'incomplete-release'));
    for (const name of ['nession', 'nession-server']) {
      const file = path.join(incompleteDir, name);
      fs.copyFileSync(realBinaryPath(name), file);
      fs.chmodSync(file, 0o755);
    }
    const incompleteTarball = path.join(base, 'incomplete.tar.gz');
    execFileSync('tar', ['-czf', incompleteTarball, '-C', incompleteDir, 'nession', 'nession-server']);
    const incompleteFixture = await startInstallerFixture({
      version: TARGET, assetName: release.assetName, tarball: incompleteTarball,
      checksum: sha256File(incompleteTarball),
    });
    try {
      const missingInstall = copyInstall(legacySource, path.join(base, 'missing-install'));
      const missingHome = path.join(base, 'missing-home');
      prepareHome(missingHome);
      const before = hashes(missingInstall);
      const missing = await scenario(incompleteFixture, missingInstall, missingHome);
      assert.notEqual(missing.status, 0, 'an incomplete release must fail');
      assert.match(missing.output, /missing from archive/);
      assert.deepEqual(hashes(missingInstall), before);
      assert.ok(!fs.existsSync(path.join(missingHome, 'versions')));
    } finally {
      await incompleteFixture.close();
    }
    evidence.push({
      type: 'runtime',
      value: 'a release tarball without nession-agent was refused before any binary was published',
    });

    // 5. A download failure cannot touch the old installation.
    const downloadInstall = copyInstall(legacySource, path.join(base, 'download-install'));
    const downloadHome = path.join(base, 'download-home');
    prepareHome(downloadHome);
    const beforeDownload = hashes(downloadInstall);
    const failed = await runInstaller(
      ['--version', TARGET, '--dir', downloadInstall],
      installerEnv({ base: good.base, releaseBase: good.base + '/missing' }, downloadInstall, downloadHome),
    );
    assert.notEqual(failed.status, 0, 'a 404 release must fail the install');
    assert.match(failed.output, /download failed/);
    assert.deepEqual(hashes(downloadInstall), beforeDownload);
    assert.ok(!fs.existsSync(path.join(downloadHome, 'versions')));
    evidence.push({
      type: 'runtime',
      value: 'a failed release download left the old installation unchanged',
    });
  } finally {
    await good.close();
  }

  return {
    summary: 'install.sh archives a real pre-versioned install, bootstraps a fresh machine, and '
      + 'leaves the old installation intact on checksum/download/incomplete-release failures (exact SHA ' + sha + ')',
    evidence,
  };
});
