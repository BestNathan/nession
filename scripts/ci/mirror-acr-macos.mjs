#!/usr/bin/env node
// #3832: Manual macOS OCI mirror benchmark. Does NOT deploy or attest a cluster.
// An earlier step in the same trusted macOS Job authenticates the GHCR source SHA.
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

// Only fixed enums and numeric fields can escape this function. Raw stderr may
// include signed Blob URLs, Authorization headers or credentials; never log it.
export function classifyCopyFailure(code, timedOut, diagnostic = '') {
  const message = String(diagnostic);
  const statuses = [...message.matchAll(
    /(?:\bHTTP(?:\/[0-9.]+)?\s+|\b(?:unexpected|response)\s+status(?:\s+code)?\s*[:=]?\s*|\bstatus\s*:\s*|\bstatus\s+code\s*[:=]?\s*)([1-5]\d{2})\b/gi,
  )];
  const http_status = statuses.length ? Number(statuses.at(-1)[1]) : null;
  const exit_code = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
  const result = (error_type, retryable) =>
    ({error_type, http_status, exit_code, retryable});

  // HTTP status is context-bound: a bare "401" in a signed URL is not auth.
  if ([401, 403].includes(http_status) ||
      /\b(?:unauthorized|authentication required|incorrect password|access denied|permission denied|forbidden|insufficient_scope)\b/i.test(message)) {
    return result('credential_or_permission_rejected', false);
  }
  if (/\b(?:manifest invalid|manifest unknown|blob unknown|digest mismatch|unsupported media type|invalid manifest|unsupported manifest|invalid reference)\b/i.test(message)) {
    return result('invalid_registry_content', false);
  }
  if (http_status === 408 || http_status === 429 || (http_status >= 500 && http_status <= 599)) {
    return result('registry_transient_http', true);
  }
  if (http_status !== null) return result('registry_http_rejection', false);
  if (timedOut || code === 124) return result('transfer_deadline', true);
  if (/TLS.{0,12}handshake timeout/i.test(message)) return result('tls_handshake_timeout', true);
  if (/connection reset|connection refused|unexpected EOF|broken pipe|connection aborted|connection closed by peer/i.test(message)) {
    return result('connection_reset', true);
  }
  if (/context deadline|i\/o timeout|network is unreachable|dial tcp|connection timed out|timeout awaiting response headers|no such host|temporary failure in name resolution|context canceled/i.test(message)) {
    return result('network_transport', true);
  }
  if (code === 127) return result('tool_unavailable', false);
  if (code === 137 || code === null) return result('process_interrupted', false);
  return result('copy_error', false);
}

// Preserve the earlier stable category-only interface for login/preflight.
export function failureClass(code, timedOut, diagnostic = '') {
  return classifyCopyFailure(code, timedOut, diagnostic).error_type;
}

// A heartbeat proves that the external command is still pending; it cannot
// claim Blob bytes, upload percentage, throughput, or destination progress.
export async function withHeartbeat({image, attempt, run, intervalMs = 30000,
  log = console.log} = {}) {
  const started = performance.now();
  const interval = setInterval(() => {
    log('ACR_MAC_MIRROR_PROGRESS_V1 ' + JSON.stringify({
      image, attempt, phase: 'oci_transfer_and_index',
      elapsed_seconds: seconds(started), status: 'running',
    }));
  }, intervalMs);
  interval.unref();
  try { return await run(); }
  finally { clearInterval(interval); }
}

function seconds(start) { return Number(((performance.now() - start) / 1000).toFixed(3)); }
function stamp() { return new Date().toISOString(); }
function check(condition, message) { if (!condition) throw Error(message); }

// Raw regctl stdout/stderr is kept in memory only. It can contain signed URLs;
// never print or save it. The only exposed failure data is a fixed class.
function command(args, {stdin = '', timeoutMs = 90000, env = process.env} = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    const child = spawn('regctl', args, {env, stdio: ['pipe', 'pipe', 'pipe']});
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

async function must(args, timeoutMs = 90000, stdin = '', env = process.env) {
  const result = await command(args, {timeoutMs, stdin, env});
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

// A phase is a measured wall-clock operation, not an inferred byte transfer.
// The OCI client, not this script, owns architecture and blob scheduling.
function markPhase(owner, name, started, outcome, detail = {}) {
  const phase = {name, elapsed_seconds: seconds(started), outcome, ...detail};
  owner.phases.push(phase);
  console.log('ACR_MAC_MIRROR_PHASE_V1 ' + JSON.stringify({
    image: owner.name || null, ...phase,
  }));
  return phase;
}

async function measure(owner, name, run) {
  const started = performance.now();
  try {
    const value = await run();
    markPhase(owner, name, started, 'success');
    return value;
  } catch (error) {
    markPhase(owner, name, started, 'failure');
    throw error;
  }
}

function appendSummary(result) {
  const output = process.env.GITHUB_STEP_SUMMARY;
  if (!output) return;
  const lines = [
    '## macOS ACR native OCI mirror timing',
    '',
    '- Source SHA: ' + result.source_sha,
    '- Authenticated GHCR source run: ' + result.source_run_id + '/' + result.source_run_attempt,
    '- Runner: ' + result.runner,
    '- Started/finished (UTC): ' + result.started_at + ' / ' + result.finished_at,
    '- Role concurrency limit: ' + result.max_concurrent_images,
    '- Status: **' + result.status + '**',
    '- Whole script (monotonic): **' + result.total_elapsed_seconds + ' s**',
    '- Sum of individual role durations (may overlap): ' + result.sum_role_elapsed_seconds + ' s',
    '',
    '| Image | Source digest (s) | Source index (s) | OCI transfer + index (s) | Destination verify (s) | Role total (s) | Attempts | Result |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  const phaseSum = (role, name) => role.phases
    .filter(phase => phase.name === name)
    .reduce((total, phase) => total + phase.elapsed_seconds, 0)
    .toFixed(3);
  for (const role of result.roles) {
    lines.push('| ' + role.name + ' | ' + phaseSum(role, 'source_digest') +
      ' | ' + phaseSum(role, 'source_index') +
      ' | ' + phaseSum(role, 'oci_transfer_and_index') +
      ' | ' + phaseSum(role, 'destination_verify') +
      ' | ' + role.elapsed_seconds.toFixed(3) +
      ' | ' + role.attempts.length + ' | ' + role.status + ' |');
    for (const arch of role.arches) {
      lines.push('- ' + role.name + '/' + arch.arch + ': source ' +
        (arch.source_digest || 'unknown') + ', destination ' +
        (arch.destination_digest || 'unknown') + ', ' + arch.status);
    }
    for (const attempt of role.attempts) {
      lines.push('- ' + role.name + ' native OCI attempt ' + attempt.attempt +
        ': ' + attempt.elapsed_seconds + ' s, ' + attempt.outcome +
        ', exit ' + (attempt.exit_code ?? 'signal') +
        ', HTTP ' + (attempt.http_status ?? 'none') +
        ', retryable ' + attempt.retryable + ', decision ' + attempt.decision +
        ', chunk ' + attempt.chunk_bytes + ' bytes');
    }
  }
  lines.push('', '### Registry authentication / setup');
  for (const phase of result.phases) {
    lines.push('- ' + phase.name + ': ' + phase.elapsed_seconds + ' s (' + phase.outcome + ')');
  }
  lines.push('', '**Measurement boundary:** OCI transfer-and-index includes the regctl-owned ' +
    'platform selection, destination Blob reuse/check, Blob copy and final index publication. ' +
    'The CLI does not expose each internal sub-operation duration; do not infer actual ' +
    'transferred bytes or bandwidth from layer/manifest sizes. Role totals overlap when ' +
    'concurrency is greater than one. This manual benchmark does not deploy Staging.');
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
  const concurrency = Number(env.MIRROR_MAX_CONCURRENT_IMAGES || '2');
  check(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4,
    'invalid_mirror_role_concurrency');
  // Short fixture-only heartbeat intervals make timing observable in CI,
  // while trusted production runs always use one 30-second interval.
  const heartbeatMs = env.MIRROR_ACR_TEST_ALLOW_PLATFORM === '1'
    ? Number(env.MIRROR_ACR_TEST_HEARTBEAT_MS || '30000') : 30000;
  check(Number.isInteger(heartbeatMs) && heartbeatMs >= 10 && heartbeatMs <= 30000,
    'invalid_mirror_heartbeat_interval');

  const jobStart = performance.now();
  const selected = image === 'all' ? ROLES : [image];
  const result = {
    schema_version: 2, kind: 'nession_mac_acr_mirror_benchmark',
    source_sha: sourceSha, source_run_id: Number(sourceRunId),
    source_run_attempt: Number(sourceRunAttempt),
    workflow_run_id: String(env.GITHUB_RUN_ID),
    workflow_run_attempt: String(env.GITHUB_RUN_ATTEMPT),
    runner: String(env.RUNNER_NAME || 'unknown'),
    max_concurrent_images: Math.min(concurrency, selected.length),
    started_at: stamp(), finished_at: null, total_elapsed_seconds: 0,
    sum_role_elapsed_seconds: 0, phases: [],
    status: 'failure', roles: selected.map(name => ({
      name, status: 'pending', elapsed_seconds: 0, phases: [],
      arches: [], attempts: [], error: null,
    })), error: null,
  };

  const outputDir = env.MIRROR_RESULT_DIR ||
    path.join(env.RUNNER_TEMP || os.tmpdir(), 'acr-mac-mirror');
  const tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'nession-regctl-'));
  fs.chmodSync(tmp, 0o700);
  const previousConfig = process.env.REGCTL_CONFIG;
  const previousDocker = process.env.DOCKER_CONFIG;
  process.env.REGCTL_CONFIG = path.join(tmp, 'regctl.json');
  process.env.DOCKER_CONFIG = path.join(tmp, 'docker');
  fs.mkdirSync(process.env.DOCKER_CONFIG, {mode: 0o700});

  async function mirrorRole(role) {
    const report = result.roles.find(r => r.name === role);
    const roleStart = performance.now();
    const tag = role + '-' + sourceSha.slice(0, 7);
    const sourceTag = SOURCE + ':' + tag;
    const target = TARGET + ':' + tag;
    const roleConfig = path.join(tmp, 'regctl-' + role + '.json');
    try {
      // Each regctl process reads an isolated configuration: retrying a
      // smaller chunk in one role cannot race another role's registry setting.
      // regctl may persist login credentials in REGCTL_CONFIG or in
      // DOCKER_CONFIG; both stores are job-private. A missing regctl file is
      // valid, and registry set can initialize the per-role config.
      if (fs.existsSync(process.env.REGCTL_CONFIG)) {
        fs.copyFileSync(process.env.REGCTL_CONFIG, roleConfig);
        fs.chmodSync(roleConfig, 0o600);
      }
      const roleEnv = {...process.env, REGCTL_CONFIG: roleConfig};
      const sourceDigestResult = await measure(report, 'source_digest', () =>
        must(['image', 'digest', sourceTag]));
      const sourceDigest = sourceDigestResult.stdout.trim();
      check(DIGEST.test(sourceDigest), 'invalid_source_index_digest');
      report.source_index_digest = sourceDigest;
      const pinnedSource = SOURCE + '@' + sourceDigest;
      const expected = await measure(report, 'source_index', () => readPlatforms(pinnedSource));
      // OCI owns platform selection, child manifest copying, Blob de-duplication
      // and index publication. No architecture-level copy loop lives here.
      for (const arch of ARCHES) {
        report.arches.push({arch, source_digest: expected[arch],
          destination_digest: null, status: 'pending'});
      }

      let copied = false;
      for (let attempt = 0; attempt < CHUNKS.length; attempt++) {
        const chunk = CHUNKS[attempt];
        await measure(report, 'registry_chunk_config', () =>
          must(['registry', 'set', REGISTRY,
            '--blob-max', '1048576', '--blob-chunk', String(chunk)], 90000, '', roleEnv));
        const start = performance.now();
        const copy = await withHeartbeat({
          image: role, attempt: attempt + 1, intervalMs: heartbeatMs,
          run: () => invoke([
            'index', 'create', target, '--ref', pinnedSource,
            '--platform', 'linux/amd64', '--platform', 'linux/arm64',
          ], {timeoutMs: 720000, env: roleEnv}),
        });
        const diagnostic = copy.ok
          ? {error_type: 'success', exit_code: 0, http_status: null, retryable: false}
          : classifyCopyFailure(copy.code, copy.timedOut, copy.diagnostic);
        const outcome = diagnostic.error_type;
        const decision = copy.ok ? 'success' :
          diagnostic.retryable && attempt < CHUNKS.length - 1 ? 'retry' : 'stop';
        const phase = markPhase(report, 'oci_transfer_and_index', start, outcome,
          {attempt: attempt + 1, chunk_bytes: chunk});
        const record = {attempt: attempt + 1, chunk_bytes: chunk,
          elapsed_seconds: phase.elapsed_seconds, outcome,
          exit_code: diagnostic.exit_code, http_status: diagnostic.http_status,
          retryable: diagnostic.retryable, decision};
        report.attempts.push(record);
        console.log('ACR_MAC_MIRROR_ATTEMPT_V2 ' +
          JSON.stringify({image: role, ...record}));
        if (copy.ok) { copied = true; break; }
        // Only positively identified transient failures may retry. An
        // unknown error remains terminal rather than consuming 3×12 minutes.
        if (decision === 'stop') break;
      }
      check(copied, 'native_oci_copy_failed');
      const observed = await measure(report, 'destination_verify', () => readPlatforms(target));
      for (const arch of report.arches) {
        arch.destination_digest = observed[arch.arch];
        arch.status = arch.source_digest === arch.destination_digest ? 'success' : 'failure';
      }
      check(samePlatforms(expected, observed), 'destination_platform_digest_mismatch');
      report.status = 'success';
    } catch (e) {
      report.error = String(e.message || e).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 120);
      report.status = 'failure';
    } finally {
      report.elapsed_seconds = seconds(roleStart);
      console.log('ACR_MAC_MIRROR_ROLE_V1 ' + JSON.stringify({
        image: role, elapsed_seconds: report.elapsed_seconds,
        status: report.status, error: report.error,
      }));
    }
  }

  try {
    check(env.GHCR_USERNAME && env.GHCR_TOKEN && env.ACR_USERNAME && env.ACR_PASSWORD,
      'missing_registry_credentials');
    await measure(result, 'ghcr_login', () =>
      logIn('ghcr.io', env.GHCR_USERNAME, env.GHCR_TOKEN));
    await measure(result, 'acr_login', () =>
      logIn(REGISTRY, env.ACR_USERNAME, env.ACR_PASSWORD));
    // The next-index increment is synchronous; workers each own an entire role.
    // Preserve stable selected-role ordering in JSON regardless of completion order.
    let next = 0;
    await Promise.all(Array.from({length: result.max_concurrent_images}, async () => {
      while (next < selected.length) {
        const role = selected[next++];
        await mirrorRole(role);
      }
    }));
    result.status = result.roles.every(r => r.status === 'success') ? 'success' : 'failure';
    if (result.status !== 'success') result.error = 'one_or_more_image_mirrors_failed';
  } catch (e) {
    result.error = String(e.message || e).replace(/[^a-zA-Z0-9_ -]/g, '').slice(0, 120);
  } finally {
    result.finished_at = stamp();
    result.total_elapsed_seconds = seconds(jobStart);
    result.sum_role_elapsed_seconds = Number(result.roles.reduce(
      (total, role) => total + role.elapsed_seconds, 0).toFixed(3));
    fs.mkdirSync(outputDir, {recursive: true});
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    appendSummary(result);
    fs.rmSync(tmp, {recursive: true, force: true});
    if (previousConfig === undefined) delete process.env.REGCTL_CONFIG;
    else process.env.REGCTL_CONFIG = previousConfig;
    if (previousDocker === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = previousDocker;
  }
  console.log('ACR_MAC_MIRROR_RESULT_V1 ' + JSON.stringify({
    status: result.status, source_sha: result.source_sha,
    total_elapsed_seconds: result.total_elapsed_seconds,
    error: result.error,
  }));
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
