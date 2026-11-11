'use strict';
// Shared machinery for the #3232 release-hardening Cases.
//
// These Cases must observe the real binaries: the CLI under test, the Server
// and Agent built by the Case Smoke workflow, and — where the criterion names
// a legacy Release — the actual official release asset. The fixture server and
// checksum helpers are reused from the #3173 Cases; nothing here replaces a
// real process with a mock.
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const {
  assert,
  fs,
  root,
  targetSha,
  nessionBin,
  makeRoot,
  mkdirPrivate,
  runCli,
  assertCliSucceeds,
  spawnCli,
  spawnOrphaned,
  waitFor,
  waitForGone,
  isRunning,
  freePort,
  waitForTcp,
  serverConfig,
  agentConfig,
  readIdentity,
  writeIdentity,
  main,
  RUNTIME_DIR_ENV,
  writeFakeInstall,
  writeArchivedCli,
  makeReleaseTarball,
  startReleaseServer,
  installEnv,
  cliOutput,
  runCliAsync,
  platformString,
} = require('./release-version-cases.cjs');

const BINARIES = ['nession', 'nession-agent', 'nession-server'];

function realBinaryPath(name) {
  return path.join(root, 'target', 'debug', name);
}

/** Every real binary a release needs, failing closed when a build is absent. */
function realBinaries() {
  const binaries = BINARIES.map(realBinaryPath);
  nessionBin(); // builds the CLI if the checkout does not have one yet
  for (const binary of binaries) {
    assert.ok(
      fs.existsSync(binary),
      'the real ' + path.basename(binary) + ' is missing; the Case Smoke workflow must build it',
    );
  }
  return binaries;
}

/** A Current installation made of the real binaries (never target/debug itself). */
function writeRealInstall(installDir) {
  mkdirPrivate(installDir);
  for (const binary of realBinaries()) {
    const destination = path.join(installDir, path.basename(binary));
    fs.copyFileSync(binary, destination);
    fs.chmodSync(destination, 0o755);
  }
  return installDir;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** A real release tarball: the target binaries under a versioned asset name. */
function makeRealReleaseTarball(dir, version) {
  const binaries = path.join(dir, 'real-binaries-' + version);
  fs.mkdirSync(binaries, { recursive: true, mode: 0o700 });
  for (const binary of realBinaries()) {
    const destination = path.join(binaries, path.basename(binary));
    fs.copyFileSync(binary, destination);
    fs.chmodSync(destination, 0o755);
  }
  const assetName = 'nession-' + version + '-' + platformString() + '.tar.gz';
  const tarball = path.join(dir, assetName);
  execFileSync('tar', ['-czf', tarball, '-C', binaries, ...BINARIES], { stdio: 'ignore' });
  return { assetName, tarball, checksum: sha256File(tarball) };
}

function releaseAssetUrl(version, osName, arch) {
  return 'https://github.com/BestNathan/nession/releases/download/v' + version +
    '/nession-' + version + '-' + osName + '-' + arch + '.tar.gz';
}

/**
 * Download and checksum-verify an official release asset, then extract it.
 *
 * `v0.36.0` is the real release that predates the shared lifecycle contract
 * and the versioned installer. The Case must use the published bytes, not a
 * shell imitation of an old CLI.
 */
function downloadOfficialRelease(version, destDir) {
  const osName = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const assetName = 'nession-' + version + '-' + osName + '-' + arch + '.tar.gz';
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-release-'));
  const tarball = path.join(downloadDir, assetName);
  execFileSync('curl', ['-fsSL', '-o', tarball, releaseAssetUrl(version, osName, arch)], {
    stdio: 'ignore',
  });
  const checksums = path.join(downloadDir, 'checksums.txt');
  execFileSync('curl', [
    '-fsSL', '-o', checksums,
    'https://github.com/BestNathan/nession/releases/download/v' + version + '/checksums.txt',
  ], { stdio: 'ignore' });
  const expected = fs.readFileSync(checksums, 'utf8').split('\n').find((line) =>
    line.endsWith('  ' + assetName));
  assert.ok(expected, 'checksums.txt does not list ' + assetName);
  assert.equal(sha256File(tarball), expected.split(/\s+/)[0], 'official release checksum mismatch');

  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', tarball, '-C', destDir], { stdio: 'ignore' });
  for (const binary of BINARIES) {
    const extracted = path.join(destDir, binary);
    assert.ok(fs.existsSync(extracted), 'official release is missing ' + binary);
    fs.chmodSync(extracted, 0o755);
  }
  fs.rmSync(downloadDir, { recursive: true, force: true });
  return destDir;
}

/**
 * A dual-layout release fixture for scripts/install.sh and the CLI.
 *
 * The installer downloads from GitHub's `/releases/download/<tag>/<asset>`
 * layout; the CLI discovers releases through the API and downloads from the
 * asset's `browser_download_url`. One server answers both so the script and
 * the transaction see the same bytes and checksum.
 */
async function startInstallerFixture(release) {
  const http = require('node:http');
  const { version, assetName, tarball, checksum } = release;
  const tag = 'v' + version;
  let base = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };
    if (url.pathname.endsWith('/releases/tags/' + tag)) {
      return send(200, JSON.stringify({
        tag_name: tag,
        prerelease: false,
        assets: [
          { name: assetName, browser_download_url: base + '/download/' + assetName },
          { name: 'checksums.txt', browser_download_url: base + '/download/checksums.txt' },
        ],
      }));
    }
    if (url.pathname === '/download/' + assetName ||
        url.pathname === '/releases/download/' + tag + '/' + assetName) {
      return send(200, fs.readFileSync(tarball), 'application/gzip');
    }
    if (url.pathname === '/download/checksums.txt' ||
        url.pathname === '/releases/download/' + tag + '/checksums.txt') {
      return send(200, checksum + '  ' + assetName + '\n', 'text/plain');
    }
    return send(404, '{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
  return {
    base,
    releaseBase: base + '/releases/download',
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run a specific binary; `runCli` always runs target/debug/nession. */
function runBinary(binary, args, env, timeout = 60_000) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function spawnBinary(binary, args, env) {
  const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  child.errors = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.errors += chunk; });
  return child;
}

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('process did not exit within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Read one top-level `key = "value"` from a TOML file. */
function tomlString(file, key) {
  const text = fs.readFileSync(file, 'utf8');
  const match = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"\\s*$', 'm').exec(text);
  return match ? match[1] : null;
}

function assertUnder(file, directory, label) {
  const resolved = path.resolve(file);
  const prefix = path.resolve(directory) + path.sep;
  assert.ok(
    resolved.startsWith(prefix),
    label + ' resolved to ' + resolved + ', outside ' + directory,
  );
}

module.exports = {
  // Re-exports the Cases share with #3173/#3155.
  assert,
  fs,
  path,
  root,
  targetSha,
  nessionBin,
  makeRoot,
  mkdirPrivate,
  runCli,
  assertCliSucceeds,
  spawnCli,
  spawnOrphaned,
  waitFor,
  waitForGone,
  isRunning,
  freePort,
  waitForTcp,
  serverConfig,
  agentConfig,
  readIdentity,
  writeIdentity,
  main,
  RUNTIME_DIR_ENV,
  writeFakeInstall,
  writeArchivedCli,
  makeReleaseTarball,
  startReleaseServer,
  installEnv,
  cliOutput,
  runCliAsync,
  platformString,
  // #3232 additions.
  BINARIES,
  realBinaryPath,
  realBinaries,
  writeRealInstall,
  sha256File,
  makeRealReleaseTarball,
  downloadOfficialRelease,
  startInstallerFixture,
  runBinary,
  spawnBinary,
  waitForExit,
  tomlString,
  assertUnder,
};
