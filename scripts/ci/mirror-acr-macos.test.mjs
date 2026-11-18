import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platforms, samePlatforms, failureClass } from './mirror-acr-macos.mjs';

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
  '    if [ "$REGCTL_FIXTURE_FAIL" = "1" ]; then echo "connection reset" >&2; exit 1; fi\n' +
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
    const result = spawnSync(process.execPath, [entry, sha, image, '5', '1'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {...process.env, PATH: tmp + path.delimiter + process.env.PATH,
        MIRROR_ACR_TEST_ALLOW_PLATFORM: '1',
        MIRROR_RESULT_DIR: resultDir,
        RUNNER_TEMP: tmp,
        REGCTL_FIXTURE_TRACE: trace,
        MIRROR_MAX_CONCURRENT_IMAGES: concurrency,
        GHCR_USERNAME: 'test-user', GHCR_TOKEN: 'test-ghcr-secret',
        ACR_USERNAME: 'test-acr-user', ACR_PASSWORD: 'test-acr-secret',
        GITHUB_REPOSITORY: 'BestNathan/nession', GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'hs-mac-fixture',
        REGCTL_FIXTURE_FAIL: fail ? '1' : '0'},
    });
    if (concurrency === '5') return {result};
    const report = JSON.parse(fs.readFileSync(path.join(resultDir, 'result.json'), 'utf8'));
    assert.equal(report.source_sha, sha);
    assert.equal(report.roles.length, image === 'all' ? 4 : 1);
    assert.equal(report.max_concurrent_images, image === 'all' ? Number(concurrency) : 1);
    assert.ok(report.total_elapsed_seconds >= 0);
    assert.equal(report.roles[0].attempts.length, fail ? 3 : 1);
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
