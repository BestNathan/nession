'use strict';
// Shared machinery for the #3179 Compose persistence Cases.
//
// The Cases drive the real `deploy/docker-compose.yml` service environment and
// named volumes through a bounded verification image. The production image is
// not rebuilt inside a Case; the host-built product binaries (and the two
// verification probes) are mounted into a minimal Ubuntu image that matches
// the runner's glibc. The Compose volumes, environment and service names
// remain the deployed contract under test.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { targetSha } = require('./control-mode-cases.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const BASE_COMPOSE = path.join(ROOT, 'deploy', 'docker-compose.yml');
const execFileAsync = promisify(execFile);

/** Run one Case body asynchronously and emit the canonical JSON verdict. */
async function runAsync(fn) {
  const evidence = [];
  try {
    const summary = await fn({ evidence });
    process.stdout.write(JSON.stringify({ status: 'pass', summary, evidence }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: 'fail',
      summary: String(error && error.message ? error.message : error).slice(-4400),
      evidence: [{ type: 'runtime', value: 'the Compose persistence probe did not establish the criterion' }],
    }) + '\n');
    process.exitCode = 1;
  }
}

/** Run one command without blocking the Case's in-process blob HTTP server. */
async function checked(command, args, { timeout = 120000, cwd = ROOT, env = {} } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed: ${stderr || error.message}${stdout ? '\n' + stdout : ''}`,
    );
  }
}

async function buildProbe(packageName, binaryName) {
  await checked('cargo', ['build', '-p', packageName, '--bin', binaryName], { timeout: 120000 });
  const binary = path.join(ROOT, 'target', 'debug', binaryName);
  if (!fs.existsSync(binary)) throw new Error('probe binary was not built: ' + binary);
  return binary;
}

/** Build one minimal verification image with or without erofs-utils. */
async function buildTestImage(tag, { erofs = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-3179-image-'));
  const dockerfile = path.join(dir, 'Dockerfile');
  fs.writeFileSync(
    dockerfile,
    [
      'FROM ubuntu:24.04',
      'ARG WITH_EROFS=0',
      'RUN if [ "$WITH_EROFS" = "1" ]; then \\',
      '      apt-get update && \\',
      '      apt-get install -y --no-install-recommends ca-certificates erofs-utils && \\',
      '      rm -rf /var/lib/apt/lists/*; \\',
      '    fi',
      '',
    ].join('\n'),
  );
  try {
    await checked(
      'docker',
      ['build', '--build-arg', `WITH_EROFS=${erofs ? '1' : '0'}`, '-f', dockerfile, '-t', tag, ROOT],
      { timeout: 180000 },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return tag;
}

/** Deterministic digest for the fake blob server fixture. */
function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Serve one immutable blob body; expose request/body counters to the Case. */
async function startBlobServer(body) {
  const digest = 'sha256:' + sha256(body);
  let requests = 0;
  let bodyBytes = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    bodyBytes += body.length;
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const port = server.address().port;
  return {
    digest,
    size: body.length,
    url: `http://host.docker.internal:${port}/blob`,
    stats: () => ({ requests, bodyBytes }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function quote(value) {
  return '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

/** Write a Compose override that keeps the service env/volumes and swaps the image. */
function writeOverride({ project, tag, probes = {}, mounts = {}, extraHosts = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `nession-3179-${project}-`));
  const file = path.join(dir, 'compose.override.yml');
  const services = [];
  for (const service of ['server', 'agent', 'agent-remote']) {
    const lines = [`  ${service}:`, `    image: ${tag}`];
    const volumes = [];
    if (probes[service]) volumes.push(`${probes[service]}:/probe:ro`);
    for (const mount of mounts[service] || []) volumes.push(mount);
    if (volumes.length) {
      lines.push('    volumes:');
      for (const volume of volumes) lines.push(`      - ${quote(volume)}`);
    }
    if (extraHosts.length) {
      lines.push('    extra_hosts:');
      for (const host of extraHosts) lines.push(`      - ${quote(host)}`);
    }
    services.push(lines.join('\n'));
  }
  fs.writeFileSync(file, 'services:\n' + services.join('\n') + '\n');
  return { dir, file };
}

function composeArgs(project, override) {
  return ['compose', '-p', project, '-f', BASE_COMPOSE, '-f', override.file];
}

async function composeRun(project, override, profile, service, command, { timeout = 120000 } = {}) {
  return checked(
    'docker',
    [...composeArgs(project, override), '--profile', profile, 'run', '--rm', '--no-deps', service, ...command],
    { timeout },
  );
}

async function composeDown(project, override, { volumes = false } = {}) {
  try {
    await checked(
      'docker',
      [...composeArgs(project, override), 'down', ...(volumes ? ['-v'] : []), '--remove-orphans'],
      { timeout: 120000 },
    );
  } catch (error) {
    if (!/no resource found|no such|not found/i.test(String(error.message))) throw error;
  }
}

function lastJson(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('probe emitted no JSON output');
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error('probe output is not JSON: ' + lines[lines.length - 1]);
  }
}

function uniqueProject(prefix) {
  return `${prefix}-${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = {
  ROOT,
  BASE_COMPOSE,
  targetSha,
  runAsync,
  checked,
  buildProbe,
  buildTestImage,
  startBlobServer,
  sha256,
  writeOverride,
  composeRun,
  composeDown,
  lastJson,
  uniqueProject,
};
