'use strict';
// Shared machinery for the #3155 source-aligned Cases.
//
// The Cases observe the real CLI: the runtime directory contract, the
// foreground/background PID lifecycle and the migration from legacy
// home-relative PID files. Everything here is an observation helper; the
// criteria themselves stay in each Case's verifier.
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { targetSha } = require('./control-mode-cases.cjs');

const root = path.resolve(__dirname, '../../..');
const RUNTIME_DIR_NAME = 'nession';
const RUNTIME_DIR_ENV = 'NESSION_RUNTIME_DIR';

function nessionBin() {
  const binary = path.join(root, 'target', 'debug', 'nession');
  if (fs.existsSync(binary)) return binary;
  const build = spawnSync('cargo', ['build', '-p', 'nession-cli'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', RUSTC_WRAPPER: '' },
  });
  if (build.error) throw build.error;
  if (build.status !== 0) {
    throw new Error('building the CLI failed: ' + String(build.stderr || build.stdout).slice(-4000));
  }
  if (!fs.existsSync(binary)) throw new Error('cargo build did not produce target/debug/nession');
  return binary;
}

function makeRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3155-' + label + '-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function runtimeEnv({ home, runtimeDir, xdgBase, darwinBase, extra } = {}) {
  const env = { ...process.env, NESSION_NO_UPDATE_CHECK: '1' };
  delete env[RUNTIME_DIR_ENV];
  delete env.XDG_RUNTIME_DIR;
  delete env._CS_DARWIN_USER_TEMP_DIR;
  if (home) {
    env.HOME = home;
    env.NESSION_HOME = home;
  }
  if (runtimeDir) env[RUNTIME_DIR_ENV] = runtimeDir;
  if (xdgBase) env.XDG_RUNTIME_DIR = xdgBase;
  if (darwinBase) env._CS_DARWIN_USER_TEMP_DIR = darwinBase;
  return { ...env, ...extra };
}

function runCli(args, env, timeout = 30_000) {
  const result = spawnSync(nessionBin(), args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function assertCliSucceeds(result, label) {
  assert.equal(
    result.status,
    0,
    label + ' failed (exit ' + result.status + '): ' +
      String(result.stderr || result.stdout).slice(-3500),
  );
  return result;
}

/**
 * Start a foreground daemon the way an operator's shell does, then let the
 * shell exit so the daemon is reaped by init rather than by this verifier.
 * Otherwise `server stop` would correctly signal a process that this verifier
 * keeps as an unreaped child (a zombie still answers `kill(pid, 0)`).
 */
function spawnOrphaned(args, env, logDir) {
  const stdoutFile = path.join(logDir, 'foreground.out');
  const stderrFile = path.join(logDir, 'foreground.err');
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = quote(nessionBin()) + ' ' + args.map(quote).join(' ') +
    ' >' + quote(stdoutFile) + ' 2>' + quote(stderrFile) + ' & echo $!';
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('failed to start the foreground daemon: ' + result.stderr);
  }
  const pid = Number(String(result.stdout).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the shell did not report the daemon pid');
  return { pid, stdoutFile, stderrFile };
}

function daemonLogs(started) {
  const stderr = fs.existsSync(started.stderrFile)
    ? fs.readFileSync(started.stderrFile, 'utf8') : '';
  const stdout = fs.existsSync(started.stdoutFile)
    ? fs.readFileSync(started.stdoutFile, 'utf8') : '';
  return (stdout + '\n' + stderr).trim();
}

async function waitForGone(pid, timeoutMs = 20_000, label = 'process ' + pid) {
  await waitFor(() => !isRunning(pid), timeoutMs, label);
}

function spawnCli(args, env) {
  const child = spawn(nessionBin(), args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.output = '';
  child.errors = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.errors += chunk; });
  return child;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for ' + label);
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

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child, 5_000).catch(() => {});
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForTcp(port, timeoutMs = 15_000) {
  return waitFor(() => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  }), timeoutMs, 'TCP 127.0.0.1:' + port);
}

function serverConfig(dir, port) {
  const file = path.join(dir, 'server-config.toml');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    'listen_address = "127.0.0.1:' + port + '"',
    'tls_cert_path = ""',
    'tls_key_path = ""',
    'auth_token = ""',
    'db_path = "' + path.join(dir, 'nession.db') + '"',
    'heartbeat_timeout_secs = 120',
    '',
  ].join('\n'));
  return file;
}

function agentConfig(dir, { serverPort, agentPort, home }) {
  const file = path.join(dir, 'agent-config.toml');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    'agent_id = "acceptance-3155-agent"',
    'server_url = "ws://127.0.0.1:' + serverPort + '/ws"',
    'auth_token = ""',
    'listen_address = "127.0.0.1:' + agentPort + '"',
    'advertise_address = "127.0.0.1"',
    'disable_address_autodetect = true',
    'default_working_dir = "' + home + '"',
    '',
  ].join('\n'));
  return file;
}

function readIdentity(file) {
  const text = fs.readFileSync(file, 'utf8');
  const identity = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index === -1) continue;
    identity[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  if (!identity.pid || !identity.started_at || !identity.kind) {
    throw new Error('not a process identity: ' + JSON.stringify(text));
  }
  return {
    pid: Number(identity.pid),
    started_at: Number(identity.started_at),
    kind: identity.kind,
  };
}

function writeIdentity(file, { pid, startedAt, kind }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'pid=' + pid,
    'started_at=' + startedAt,
    'kind=' + kind,
    '',
  ].join('\n'));
}

function assertPrivateDirectory(dir) {
  const stat = fs.statSync(dir);
  assert.ok(stat.isDirectory(), dir + ' must be a directory');
  assert.equal(stat.mode & 0o777, 0o700, dir + ' must be owner-private (0700)');
  assert.equal(stat.uid, process.getuid(), dir + ' must be owned by the current user');
}

function runtimeArtifacts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}

/**
 * Run an async Case body and emit the single JSON line the Acceptance driver
 * reads. Errors become Fail with their message, never a claimed Pass.
 */
function main(fn) {
  Promise.resolve()
    .then(fn)
    .then(({ summary, evidence }) => {
      process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
    })
    .catch((error) => {
      const message = String(error && error.stack ? error.stack : error).slice(-4400);
      process.stdout.write(JSON.stringify({
        status: 'fail',
        summary: message,
        evidence: [{
          type: 'runtime',
          value: 'the exact-SHA runtime observations did not establish the criterion',
        }],
      }) + '\n');
      process.exitCode = 1;
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
  runtimeEnv,
  runCli,
  assertCliSucceeds,
  spawnCli,
  spawnOrphaned,
  daemonLogs,
  waitForGone,
  waitFor,
  waitForExit,
  isRunning,
  stopProcess,
  freePort,
  waitForTcp,
  serverConfig,
  agentConfig,
  readIdentity,
  writeIdentity,
  assertPrivateDirectory,
  runtimeArtifacts,
  RUNTIME_DIR_NAME,
  RUNTIME_DIR_ENV,
  main,
};
