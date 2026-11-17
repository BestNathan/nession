#!/usr/bin/env node
// #3832: Manual macOS OCI mirror benchmark. Does NOT deploy or attest a cluster.
// The authenticated GHCR source SHA is verified by the trusted Ubuntu preflight.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SOURCE = 'ghcr.io/bestnathan/nession';
const TARGET = 'crpi-ck06yio90i1ttwlz.cn-beijing.personal.cr.aliyuncs.com/n_public/nession';
const REGISTRY = TARGET.split('/')[0];
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROLES = ['server', 'agent', 'mcp', 'ui'];
const ARCHES = ['amd64', 'arm64'];
const CHUNKS = [4194304, 1048576, 524288];

export function platforms(manifest) {
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.manifests)) {
    throw Error('not an OCI multi-platform index');
  }
  const chosen = manifest.manifests.filter(item =>
    item?.platform?.os === 'linux' && ARCHES.includes(item?.platform?.architecture));
  if (chosen.length !== 2 ||
      ARCHES.some(arch => chosen.filter(item => item.platform.architecture === arch).length !== 1) ||
      chosen.some(item => !DIGEST.test(item.digest))) {
    throw Error('expected exactly one valid linux/amd64 and linux/arm64 manifest');
  }
  return Object.fromEntries(chosen.map(item => [item.platform.architecture, item.digest]));
}

export function samePlatforms(a, b) {
  return ARCHES.every(arch => a[arch] === b[arch]) &&
    Object.keys(b).length === 2;
}

export function failureClass(code, timedOut, diagnostic = '') {
  if (/401|403|unauthorized|authentication required|denied|incorrect.password/i.test(diagnostic)) {
    return 'credential_or_permission_rejected';
  }
  if (timedOut || code === 124 || code === 137) return 'transfer_deadline';
  if (/TLS.handshake.timeout/i.test(diagnostic)) return 'tls_handshake_timeout';
  if (/connection reset|connection refused|unexpected EOF|broken pipe/i.test(diagnostic)) return 'connection_reset';
  if (/context.deadline|i.o timeout|network.unreachable|dial tcp|context canceled/i.test(diagnostic)) {
    return 'network_transport';
  }
  return 'copy_error';
}

function seconds(start) { return Number(((performance.now() - start) / 1000).toFixed(3)); }
function stamp() { return new Date().toISOString(); }
function check(condition, message) { if (!condition) throw Error(message); }

// Raw regctl stdout/stderr is kept in memory only. It can contain signed URLs;
// never print or save it. The only exposed failure data is a fixed class.
function command(args, {stdin = '', timeoutMs = 90000} = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    const child = spawn('regctl', args, {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', diagnostic = '', timedOut = false, done = false;
    const add = (current, chunk) => (current + String(chunk)).slice(0, 262144);
    child.stdout.on('data', chunk => { stdout = add(stdout, chunk); });
    child.stderr.on('data', chunk => { diagnostic = add(diagnostic, chunk); });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, code, stdout, diagnostic,
        timedOut, elapsed_seconds: seconds(start)});
    };
    child.on('error', e => finish(e.code === 'ENOENT' ? 127 : 1));
    child.on('close', code => finish(code));
  });
}

async function must(args, timeoutMs = 90000, stdin = '') {
  const result = await command(args, {timeoutMs, stdin});
  if (!result.ok) {
    throw Error(failureClass(result.code, result.timedOut, result.diagnostic));
  }
  return result;
}

async function readPlatforms(ref) {
  const result = await must(['manifest', 'get', ref, '--format', 'raw-body']);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw Error('invalid_registry_manifest_json'); }
  return platforms(parsed);
}

async function logIn(registry, username, token) {
  check(Boolean(username && token), 'missing_registry_credentials');
  await must(['registry', 'login', registry, '--user', username, '--pass-stdin'], 90000, token);
}

function appendSummary(result) {
  const output = process.env.GITHUB_STEP_SUMMARY;
  if (!output) return;
  const lines = [
    '## macOS ACR mirror timing',
    '',
    '- Source SHA: ' + result.source_sha,
    '- Authenticated GHCR source run: ' + result.source_run_id + '/' + result.source_run_attempt,
    '- Runner: ' + result.runner,
    '- Start (UTC): ' + result.started_at,
    '- End (UTC): ' + result.finished_at,
    '- Result: **' + result.status + '**',
    '- Total runner elapsed: **' + result.total_elapsed_seconds + ' s** (includes login, registry discovery, copies and verification)',
    '',
    '| Image | amd64 copy (s) | arm64 copy (s) | Role total (s) | Result |',
    '|---|---:|---:|---:|---|',
  ];
  for (const role of result.roles) {
    const arch = name => {
      const item = role.arches.find(x => x.arch === name);
      return item ? item.elapsed_seconds.toFixed(3) : '—';
    };
    lines.push('| ' + role.name + ' | ' + arch('amd64') + ' | ' +
      arch('arm64') + ' | ' + role.elapsed_seconds.toFixed(3) +
      ' | ' + role.status + ' |');
    for (const attempt of role.attempts) {
      lines.push('- ' + role.name + '/' + attempt.arch + ' attempt ' +
        attempt.attempt + ': ' + attempt.elapsed_seconds + ' s, ' + attempt.outcome +
        ', chunk ' + attempt.chunk_bytes + ' bytes');
    }
  }
  lines.push('', 'Duration uses the runner monotonic clock; copy time is measured over real regctl subprocesses. No throughput estimate is claimed (ACR may reuse existing blobs).',
    'This manual benchmark **does not update GitOps or certify a Staging deployment**.');
  if (result.error) lines.push('Failure class: ' + result.error);
  fs.appendFileSync(output, lines.join('\n') + '\n');
}

export async function execute({sourceSha, image, sourceRunId, sourceRunAttempt,
  env = process.env, invoke = command} = {}) {
  check(SHA.test(sourceSha), 'invalid_source_sha');
  check(image === 'all' || ROLES.includes(image), 'invalid_image_selection');
  check(/^\d+$/.test(String(sourceRunId)) && /^\d+$/.test(String(sourceRunAttempt)),
    'missing_authenticated_source_run');
  check(process.platform === 'darwin' || env.MIRROR_ACR_TEST_ALLOW_PLATFORM === '1',
    'macOS_runner_required');
  check(env.GITHUB_REPOSITORY === 'BestNathan/nession' &&
    env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    'untrusted_workflow_context');
  check(Boolean(env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT), 'missing_workflow_identity');
  const jobStart = performance.now();
  const result = {
    schema_version: 1, kind: 'nession_mac_acr_mirror_benchmark',
    source_sha: sourceSha, source_run_id: Number(sourceRunId),
    source_run_attempt: Number(sourceRunAttempt),
    workflow_run_id: String(env.GITHUB_RUN_ID),
    workflow_run_attempt: String(env.GITHUB_RUN_ATTEMPT),
    runner: String(env.RUNNER_NAME || 'unknown'),
    started_at: stamp(), finished_at: null, total_elapsed_seconds: 0,
    status: 'failure', roles: [], error: null,
  };
  const outputDir = env.MIRROR_RESULT_DIR || path.join(env.RUNNER_TEMP || os.tmpdir(), 'acr-mac-mirror');
  const tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'nession-regctl-'));
  fs.chmodSync(tmp, 0o700);
  const previousConfig = process.env.REGCTL_CONFIG;
  const previousDocker = process.env.DOCKER_CONFIG;
  process.env.REGCTL_CONFIG = path.join(tmp, 'regctl.json');
  process.env.DOCKER_CONFIG = path.join(tmp, 'docker');
  fs.mkdirSync(process.env.DOCKER_CONFIG, {mode: 0o700});
  try {
    check(env.GHCR_USERNAME && env.GHCR_TOKEN && env.ACR_USERNAME && env.ACR_PASSWORD,
      'missing_registry_credentials');
    // Never output raw auth results or user-supplied secrets.
    await logIn('ghcr.io', env.GHCR_USERNAME, env.GHCR_TOKEN);
    await logIn(REGISTRY, env.ACR_USERNAME, env.ACR_PASSWORD);
    const selected = image === 'all' ? ROLES : [image];
    const short = sourceSha.slice(0, 7);
    for (const role of selected) {
      const roleStart = performance.now();
      const report = {name: role, status: 'failure', elapsed_seconds: 0,
        arches: [], attempts: [], error: null};
      result.roles.push(report);
      try {
        const tag = role + '-' + short;
        const source = SOURCE + ':' + tag;
        const target = TARGET + ':' + tag;
        const expected = await readPlatforms(source);
        for (const arch of ARCHES) {
          const archStart = performance.now();
          const destArch = target + '-' + arch;
          let success = false;
          for (let i = 0; i < CHUNKS.length; i++) {
            const chunk = CHUNKS[i];
            await must(['registry', 'set', REGISTRY,
              '--blob-max', '1048576', '--blob-chunk', String(chunk)]);
            const copy = await invoke(['image', 'copy', SOURCE + '@' + expected[arch], destArch],
              {timeoutMs: 360000});
            const outcome = copy.ok ? 'success' :
              failureClass(copy.code, copy.timedOut, copy.diagnostic);
            const attempt = {arch, attempt: i + 1, chunk_bytes: chunk,
              elapsed_seconds: copy.elapsed_seconds, outcome};
            report.attempts.push(attempt);
            console.log('ACR_MAC_MIRROR_ATTEMPT_V1 ' + JSON.stringify({
              image: role, ...attempt}));
            if (copy.ok) { success = true; break; }
            if (outcome === 'credential_or_permission_rejected' || outcome === 'copy_error') break;
          }
          report.arches.push({arch, elapsed_seconds: seconds(archStart),
            status: success ? 'success' : 'failure'});
          if (!success) throw Error('copy_failed_' + arch);
        }
        await must(['index', 'create', target, '--ref', target + '-amd64',
          '--ref', target + '-arm64']);
        const observed = await readPlatforms(target);
        check(samePlatforms(expected, observed), 'destination_platform_digest_mismatch');
        report.status = 'success';
      } catch (e) {
        // Only errors composed from fixed internal strings/classes are reported.
        report.error = String(e.message || e).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 120);
      } finally {
        report.elapsed_seconds = seconds(roleStart);
        console.log('ACR_MAC_MIRROR_ROLE_V1 ' + JSON.stringify({
          image: role, elapsed_seconds: report.elapsed_seconds, status: report.status,
          error: report.error}));
      }
    }
    result.status = result.roles.every(r => r.status === 'success') ? 'success' : 'failure';
    if (result.status !== 'success') result.error = 'one_or_more_image_mirrors_failed';
  } catch (e) {
    result.error = String(e.message || e).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 120);
  } finally {
    result.finished_at = stamp();
    result.total_elapsed_seconds = seconds(jobStart);
    fs.mkdirSync(outputDir, {recursive: true});
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    appendSummary(result);
    fs.rmSync(tmp, {recursive: true, force: true});
  }
  console.log('ACR_MAC_MIRROR_RESULT_V1 ' + JSON.stringify({
    status: result.status, source_sha: result.source_sha,
    total_elapsed_seconds: result.total_elapsed_seconds, error: result.error}));
  if (result.status !== 'success') process.exitCode = 1;
  return result;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const [sourceSha, image, runId, attempt] = process.argv.slice(2);
  execute({sourceSha, image, sourceRunId: runId, sourceRunAttempt: attempt})
    .catch(e => { console.error('ACR_MAC_MIRROR_ERROR_V1 ' +
      String(e.message || e).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 100));
      process.exitCode = 1; });
}
