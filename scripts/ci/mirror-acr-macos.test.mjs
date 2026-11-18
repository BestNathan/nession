import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platforms, samePlatforms, failureClass, classifyCopyFailure, withHeartbeat } from './mirror-acr-macos.mjs';

const sha = 'a'.repeat(40);
const amd = 'sha256:' + '1'.repeat(64);
const arm = 'sha256:' + '2'.repeat(64);
const indexed = () => ({schemaVersion: 2, manifests: [
  {platform: {os: 'linux', architecture: 'amd64'}, digest: amd},
  {platform: {os: 'linux', architecture: 'arm64'}, digest: arm},
  {platform: {os: 'unknown', architecture: 'unknown'}, digest: 'sha256:' + '3'.repeat(64)},
]});

test('OCI index keeps exactly two real Linux architectures and ignores attestation manifests', () => {
  const actual = platforms(indexed());
  assert.deepEqual(actual, {amd64: amd, arm64: arm});
  assert.equal(samePlatforms(actual, {arm64: arm, amd64: amd}), true);
  assert.equal(samePlatforms(actual, {arm64: arm, amd64: 'sha256:' + '4'.repeat(64)}), false);
  assert.throws(() => platforms({schemaVersion: 2, manifests: indexed().manifests.slice(0, 1)}));
  assert.throws(() => platforms({schemaVersion: 2, manifests: [
    indexed().manifests[0], indexed().manifests[0], indexed().manifests[1],
  ]}));
  assert.throws(() => platforms({schemaVersion: 2, manifests: [
    indexed().manifests[0], {...indexed().manifests[1], digest: 'sha256:invalid'},
  ]}));
});

test('registry errors are normalized without exposing raw authentication URLs', () => {
  assert.equal(failureClass(1, false, 'HTTP 403 Forbidden https://signed.invalid/?token=secret'),
    'credential_or_permission_rejected');
  assert.equal(failureClass(143, true, 'killed'), 'transfer_deadline');
  assert.equal(failureClass(1, false, 'connection reset by peer'), 'connection_reset');
  assert.equal(failureClass(1, false, 'TLS handshake timeout'), 'tls_handshake_timeout');
});

const mock = '#!/bin/sh\n' +
  'case "$1:$2" in\n' +
  '  registry:login|registry:set) exit 0 ;;\n' +
  '  image:digest) printf "%s\\n" "sha256:' + 'a'.repeat(64) + '"; exit 0 ;;\n' +
  '  manifest:get) printf "%s\\n" ' + "'" + JSON.stringify(indexed()) + "'" + '; exit 0 ;;\n' +
  '  index:create)\n' +
  '    if [ "$4" != "--ref" ] || [ "$6" != "--platform" ] || [ "$7" != "linux/amd64" ] || [ "$8" != "--platform" ] || [ "$9" != "linux/arm64" ]; then exit 9; fi\n' +
  '    if [ -n "$REGCTL_FIXTURE_TRACE" ]; then printf "start:%s\\n" "$3" >> "$REGCTL_FIXTURE_TRACE"; fi\n' +
  '    sleep 0.10\n' +
  '    if [ -n "$REGCTL_FIXTURE_TRACE" ]; then printf "end:%s\\n" "$3" >> "$REGCTL_FIXTURE_TRACE"; fi\n' +
  '    case "$REGCTL_FIXTURE_FAIL" in\n' +
  '      1) echo "connection reset" >&2; exit 1 ;;\n' +
  '      transient-once) if [ "$(grep -c "^start:" "$REGCTL_FIXTURE_TRACE")" -eq 1 ]; then echo "unexpected status code 503 https://signed.invalid/?token=test-ghcr-secret" >&2; exit 1; fi ;;\n' +
  '      http-429) echo "response status 429 https://signed.invalid/?token=test-acr-secret" >&2; exit 1 ;;\n' +
  '      auth) echo "HTTP 403 Forbidden https://signed.invalid/?token=test-acr-secret" >&2; exit 1 ;;\n' +
  '      invalid) echo "manifest invalid https://signed.invalid/?token=test-acr-secret" >&2; exit 1 ;;\n' +
  '      unknown) echo "regctl failure https://signed.invalid/?token=test-acr-secret" >&2; exit 1 ;;\n' +
  '    esac\n' +
  '    exit 0 ;;\n' +
  'esac\n' +
  'exit 2\n';

function fixture(fail, image = 'server', concurrency = '2') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acr-mac-fixture-'));
  try {
    const fake = path.join(tmp, 'regctl');
    fs.writeFileSync(fake, mock, {mode: 0o755});
    const resultDir = path.join(tmp, 'result');
    const trace = path.join(tmp, 'trace');
    const entry = fileURLToPath(new URL('./mirror-acr-macos.mjs', import.meta.url));
    const mode = fail === true ? '1' : fail === false ? '0' : fail;
    const result = spawnSync(process.execPath, [entry, sha, image, '5', '1'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {...process.env, PATH: tmp + path.delimiter + process.env.PATH,
        MIRROR_ACR_TEST_ALLOW_PLATFORM: '1',
        MIRROR_RESULT_DIR: resultDir,
        RUNNER_TEMP: tmp,
        REGCTL_FIXTURE_TRACE: trace,
        MIRROR_MAX_CONCURRENT_IMAGES: concurrency,
        MIRROR_ACR_TEST_HEARTBEAT_MS: '20',
        GHCR_USERNAME: 'test-user', GHCR_TOKEN: 'test-ghcr-secret',
        ACR_USERNAME: 'test-acr-user', ACR_PASSWORD: 'test-acr-secret',
        GITHUB_REPOSITORY: 'BestNathan/nession', GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'hs-mac-fixture',
        REGCTL_FIXTURE_FAIL: mode},
    });
    if (concurrency === '5') return {result};
    const report = JSON.parse(fs.readFileSync(path.join(resultDir, 'result.json'), 'utf8'));
    assert.equal(report.source_sha, sha);
    assert.equal(report.roles.length, image === 'all' ? 4 : 1);
    assert.equal(report.max_concurrent_images, image === 'all' ? Number(concurrency) : 1);
    assert.ok(report.total_elapsed_seconds >= 0);
    assert.equal(report.roles[0].attempts.length,
      mode === '1' || mode === 'http-429' ? 3 : mode === 'transient-once' ? 2 : 1);
    assert.ok(!result.stdout.includes('test-ghcr-secret'));
    assert.ok(!result.stdout.includes('test-acr-secret'));
    assert.ok(!result.stderr.includes('test-acr-secret'));
    return {result, report, events: fs.readFileSync(trace, 'utf8').trim().split('\n')};
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}

test('real subprocess timings and verified two-architecture result persist on success', () => {
  const {result, report} = fixture(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'success');
  assert.equal(report.roles[0].status, 'success');
  assert.deepEqual(report.roles[0].arches.map(x => x.status), ['success', 'success']);
  assert.ok(report.roles[0].phases.some(p => p.name === 'source_digest'));
  assert.ok(report.roles[0].phases.some(p => p.name === 'source_index'));
  assert.ok(report.roles[0].phases.some(p => p.name === 'oci_transfer_and_index'));
  assert.ok(report.roles[0].phases.some(p => p.name === 'destination_verify'));
  assert.equal(report.schema_version, 2);
  assert.ok(report.roles[0].attempts.every(x => x.outcome === 'success'));
});

test('failed copy fails closed but records real attempted time and structured failure artifact', () => {
  const {result, report} = fixture(true);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.status, 'failure');
  assert.equal(report.roles[0].status, 'failure');
  assert.equal(report.roles[0].error, 'native_oci_copy_failed');
  assert.equal(report.roles[0].attempts.length, 3);
});


test('all four roles use a bounded two-worker pool and delegate both architectures to one native index create per role', () => {
  const {result, report, events} = fixture(false, 'all', '2');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'success');
  assert.deepEqual(report.roles.map(r => r.name), ['server', 'agent', 'mcp', 'ui']);
  assert.equal(report.max_concurrent_images, 2);
  assert.equal(events.length, 8);
  let active = 0, peak = 0;
  for (const event of events) {
    if (event.startsWith('start:')) {active++; peak = Math.max(peak, active);}
    if (event.startsWith('end:')) active--;
    assert.ok(active >= 0 && active <= 2);
  }
  assert.equal(active, 0);
  assert.equal(peak, 2);
  for (const role of report.roles) {
    assert.equal(role.attempts.length, 1);
    assert.equal(role.arches.length, 2);
    assert.ok(role.phases.every(p => Number.isFinite(p.elapsed_seconds)));
  }
});

test('invalid role concurrency is rejected before running a regctl subprocess', () => {
  const {result} = fixture(false, 'server', '5');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid_mirror_role_concurrency/);
});

test('native regctl platform selection and phase timing remain role scoped', () => {
  const {result, report, events} = fixture(false, 'all', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.max_concurrent_images, 1);
  assert.equal(events.length, 8);
  assert.deepEqual(report.roles.map(r => r.name), ['server', 'agent', 'mcp', 'ui']);
  assert.ok(report.roles.every(role => role.attempts.every(a => a.chunk_bytes === 4194304)));
});


test('manual macOS mirror authenticates Staging SHA before ACR secret-scoped copy in one Job', () => {
  const yml = fs.readFileSync(
    fileURLToPath(new URL('../../.github/workflows/deploy-acr-macos-mirror.yml', import.meta.url)),
    'utf8',
  );
  assert.match(yml, /\njobs:\n  mirror:\n/);
  assert.match(yml, /runs-on: \[self-hosted, macOS, hs-mac\]/);
  assert.match(yml, /github\.repository == 'BestNathan\/nession'/);
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(yml, /\n  verify-source:|needs:\s*verify-source|runs-on:\s*ubuntu/);
  assert.equal((yml.match(/- uses: actions\/checkout@v4/g) || []).length, 1);
  assert.equal((yml.match(/- uses: actions\/setup-node@v4/g) || []).length, 1);
  const source = yml.indexOf('id: source');
  const verify = yml.indexOf('node scripts/ci/verify-staging-ghcr-source.mjs verify-mirror');
  const acrSecrets = yml.indexOf('ACR_PASSWORD: $' + '{{ secrets.ALIYUN_ACR_PASSWORD }}');
  const copy = yml.indexOf('node scripts/ci/mirror-acr-macos.mjs');
  assert.ok(source !== -1 && source < verify);
  assert.ok(verify < acrSecrets && acrSecrets < copy);
  assert.match(yml, /GH_TOKEN: \${{ github\.token }}/);
  for (const name of ['source_sha', 'source_run_id', 'source_run_attempt']) {
    assert.match(yml, new RegExp('steps\\.source\\.outputs\\.' + name));
    assert.doesNotMatch(yml, new RegExp('needs\\.verify-source\\.outputs\\.' + name));
  }
  assert.match(yml, /if: always\(\)/);
  assert.match(yml, /max_concurrent_images:/);
});


test('diagnostic categories parse explicit HTTP context, never bare numbers in signed URLs', () => {
  const credential = 'https://signed.invalid/path?token=test-acr-secret-401-403';
  assert.deepEqual(classifyCopyFailure(1, false, 'unable to fetch ' + credential), {
    error_type: 'copy_error', http_status: null, exit_code: 1, retryable: false,
  });
  for (const [diagnostic, type, http_status, retryable] of [
    ['unexpected status code 503 ' + credential, 'registry_transient_http', 503, true],
    ['response status 429', 'registry_transient_http', 429, true],
    ['HTTP/1.1 408 Request Timeout', 'registry_transient_http', 408, true],
    ['HTTP 500 Internal Server Error', 'registry_transient_http', 500, true],
    ['status: 400 bad request', 'registry_http_rejection', 400, false],
    ['HTTP 404 Not Found', 'registry_http_rejection', 404, false],
    ['HTTP 403 Forbidden', 'credential_or_permission_rejected', 403, false],
    ['manifest invalid', 'invalid_registry_content', null, false],
    ['digest mismatch', 'invalid_registry_content', null, false],
    ['connection reset by peer', 'connection_reset', null, true],
    ['TLS handshake timeout', 'tls_handshake_timeout', null, true],
    ['context deadline exceeded', 'network_transport', null, true],
    ['unrecognized failure', 'copy_error', null, false],
  ]) {
    const actual = classifyCopyFailure(1, false, diagnostic);
    assert.equal(actual.error_type, type, diagnostic);
    assert.equal(actual.http_status, http_status, diagnostic);
    assert.equal(actual.retryable, retryable, diagnostic);
    assert.equal(actual.exit_code, 1, diagnostic);
    assert.ok(!JSON.stringify(actual).includes('test-acr-secret'));
    assert.ok(!JSON.stringify(actual).includes('signed.invalid'));
  }
  assert.equal(classifyCopyFailure(null, true, '').error_type, 'transfer_deadline');
  assert.equal(classifyCopyFailure(null, true, '').retryable, true);
  assert.equal(classifyCopyFailure(127, false, '').error_type, 'tool_unavailable');
  assert.equal(classifyCopyFailure(137, false, '').retryable, false);
});

test('safe transient HTTP failure retries only once and preserves exact digest verification', () => {
  const {result, report} = fixture('transient-once');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'success');
  assert.deepEqual(report.roles[0].attempts.map(a => a.decision), ['retry', 'success']);
  assert.deepEqual(report.roles[0].attempts.map(a => a.chunk_bytes), [4194304, 1048576]);
  assert.equal(report.roles[0].attempts[0].http_status, 503);
  assert.equal(report.roles[0].attempts[0].retryable, true);
  assert.deepEqual(report.roles[0].arches.map(x => x.status), ['success', 'success']);
  assert.ok(!result.stdout.includes('signed.invalid'));
  assert.ok(!JSON.stringify(report).includes('signed.invalid'));
});

test('terminal authentication, invalid manifest and unknown errors do not retry or leak secrets', () => {
  for (const [kind, expected, http] of [
    ['auth', 'credential_or_permission_rejected', 403],
    ['invalid', 'invalid_registry_content', null],
    ['unknown', 'copy_error', null],
  ]) {
    const {result, report, events} = fixture(kind);
    assert.equal(result.status, 1, kind);
    assert.equal(report.status, 'failure');
    assert.equal(report.roles[0].error, 'native_oci_copy_failed');
    assert.equal(report.roles[0].attempts.length, 1);
    assert.equal(report.roles[0].attempts[0].outcome, expected);
    assert.equal(report.roles[0].attempts[0].http_status, http);
    assert.equal(report.roles[0].attempts[0].retryable, false);
    assert.equal(report.roles[0].attempts[0].decision, 'stop');
    assert.equal(events.length, 2);
    for (const content of [result.stdout, result.stderr, JSON.stringify(report)]) {
      assert.ok(!content.includes('signed.invalid'));
      assert.ok(!content.includes('test-acr-secret'));
      assert.ok(!content.includes('test-ghcr-secret'));
    }
  }
});

test('bounded network retries exhaust at attempt 3 and preserve safe results', () => {
  const {result, report} = fixture('http-429');
  assert.equal(result.status, 1);
  assert.equal(report.roles[0].attempts.length, 3);
  assert.deepEqual(report.roles[0].attempts.map(a => a.decision), ['retry', 'retry', 'stop']);
  assert.ok(report.roles[0].attempts.every(a => a.http_status === 429 && a.retryable));
  assert.ok(!result.stdout.includes('signed.invalid'));
});

test('heartbeat has monotonic elapsed time and is removed after success and failure', async () => {
  for (const fail of [false, true]) {
    const messages = [];
    await (fail
      ? assert.rejects(() => withHeartbeat({
        image: 'agent', attempt: 1, intervalMs: 10,
        log: msg => messages.push(msg),
        run: () => new Promise((resolve, reject) =>
          setTimeout(() => reject(Error('fixture_failure')), 55)),
      }), /fixture_failure/)
      : withHeartbeat({
        image: 'agent', attempt: 1, intervalMs: 10,
        log: msg => messages.push(msg),
        run: () => new Promise(resolve => setTimeout(resolve, 55)),
      }));
    assert.ok(messages.length >= 2);
    const parsed = messages.map(msg => {
      assert.ok(msg.startsWith('ACR_MAC_MIRROR_PROGRESS_V1 '));
      return JSON.parse(msg.slice('ACR_MAC_MIRROR_PROGRESS_V1 '.length));
    });
    assert.ok(parsed.every(x => x.image === 'agent' && x.attempt === 1 &&
      x.phase === 'oci_transfer_and_index' && x.status === 'running' &&
      Number.isFinite(x.elapsed_seconds) && x.bytes === undefined &&
      x.percent === undefined));
    for (let i = 1; i < parsed.length; i++) {
      assert.ok(parsed[i].elapsed_seconds >= parsed[i - 1].elapsed_seconds);
    }
    const count = messages.length;
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(messages.length, count, 'interval leaked after invocation completed');
  }
});
