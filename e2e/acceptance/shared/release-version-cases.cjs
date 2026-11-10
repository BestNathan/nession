'use strict';
// Shared machinery for the #3173 release-version Cases.
//
// A Case must be able to drive a real install/archive against a deterministic
// release fixture: fake Current binaries (so the Case never replaces the
// binary running it), a local GitHub-compatible release server, and real
// tarballs/checksums. The CLI under test is the one built from the target SHA.
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const {
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
} = require('./runtime-directory-cases.cjs');

const BINARIES = ['nession', 'nession-agent', 'nession-server'];

function platformString() {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return os + '-' + arch;
}

function fakeCliSource(version) {
  return '#!/bin/sh\necho "nession ' + version + '"\n';
}

/** A fake Current installation. Never point this at target/debug. */
function writeFakeInstall(installDir, version) {
  fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });
  for (const name of BINARIES) {
    const file = path.join(installDir, name);
    fs.writeFileSync(file, fakeCliSource(version), { mode: 0o755 });
  }
  return installDir;
}

/** A fake archived CLI that reports which version/home it was started with. */
function writeArchivedCli(home, version) {
  const dir = path.join(home, 'versions', version, 'bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'nession');
  fs.writeFileSync(
    file,
    '#!/bin/sh\necho "SELECTED ' + version + '"\nenv | grep HOME\necho "ARGS: $*"\n',
    { mode: 0o755 },
  );
  return file;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeReleaseTarball(dir, version) {
  const binaries = path.join(dir, 'binaries-' + version);
  fs.mkdirSync(binaries, { recursive: true, mode: 0o700 });
  for (const name of BINARIES) {
    fs.writeFileSync(path.join(binaries, name), fakeCliSource(version), { mode: 0o755 });
  }
  const assetName = 'nession-' + version + '-' + platformString() + '.tar.gz';
  const tarball = path.join(dir, assetName);
  execFileSync('tar', ['-czf', tarball, '-C', binaries, ...BINARIES], { stdio: 'ignore' });
  return { assetName, tarball, checksum: sha256(tarball) };
}

/**
 * A local GitHub Releases API fixture. `releases` maps a version to a
 * `{ assetName, tarball, checksum, badChecksum }` entry. The latest release is
 * the highest SemVer key.
 */
async function startReleaseServer(releases) {
  const versions = Object.keys(releases).sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (pa[index] !== pb[index]) return pa[index] - pb[index];
    }
    return 0;
  });
  let base = '';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };
    const releaseJson = (version) => {
      const release = releases[version];
      return JSON.stringify({
        tag_name: 'v' + version,
        prerelease: false,
        assets: [
          {
            name: release.assetName,
            browser_download_url: base + '/download/' + release.assetName,
          },
          {
            name: 'checksums.txt',
            browser_download_url: base + '/download/checksums.txt',
          },
        ],
      });
    };
    if (url.pathname.endsWith('/releases/latest')) {
      return send(200, releaseJson(versions[versions.length - 1]));
    }
    const tag = /\/releases\/tags\/v(.+)$/.exec(url.pathname);
    if (tag) {
      if (!releases[tag[1]]) return send(404, '{}');
      return send(200, releaseJson(tag[1]));
    }
    if (url.pathname === '/download/checksums.txt') {
      const lines = Object.entries(releases).map(([, release]) =>
        (release.badChecksum ? '0'.repeat(64) : release.checksum) +
        '  ' + release.assetName);
      return send(200, lines.join('\n') + '\n', 'text/plain');
    }
    const download = /^\/download\/(.+)$/.exec(url.pathname);
    if (download) {
      const release = Object.values(releases).find((item) => item.assetName === download[1]);
      if (!release) return send(404, 'missing');
      return send(200, fs.readFileSync(release.tarball), 'application/gzip');
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
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function installEnv({ home, installDir, apiBase, runtimeDir, extra } = {}) {
  const env = { ...process.env, NESSION_NO_UPDATE_CHECK: '1' };
  delete env.NESSION_VERSION;
  delete env.NESSION_VERSION_DISPATCHED;
  delete env[RUNTIME_DIR_ENV];
  if (home) env.NESSION_HOME = home;
  if (installDir) env.NESSION_INSTALL_DIR = installDir;
  if (apiBase) env.NESSION_UPDATE_API_URL = apiBase;
  if (runtimeDir) env[RUNTIME_DIR_ENV] = runtimeDir;
  return { ...env, ...extra };
}

/** Run the CLI and return the joined output (for assertions). */
function cliOutput(args, env, timeout = 60_000) {
  const result = runCli(args, env, timeout);
  return { status: result.status, output: String(result.stdout) + String(result.stderr) };
}

/**
 * Run the CLI without blocking the Node event loop. An install Case serves the
 * release fixture from this process, so a synchronous spawn would starve the
 * HTTP server and every install would fail with a network error.
 */
function runCliAsync(args, env, timeout = 60_000, label = args.join(' ')) {
  const child = spawnCli(args, env);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI `' + label + '` did not exit within ' + timeout + 'ms'));
    }, timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: child.output, stderr: child.errors });
    });
  });
}

module.exports = {
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
  BINARIES,
  writeFakeInstall,
  writeArchivedCli,
  makeReleaseTarball,
  startReleaseServer,
  installEnv,
  cliOutput,
  runCliAsync,
  platformString,
};
