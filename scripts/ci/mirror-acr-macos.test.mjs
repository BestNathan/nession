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
  '  registry:login|registry:set|index:create) exit 0 ;;\n' +
  '  manifest:get) printf "%s\\n" ' + "'" + JSON.stringify(indexed()) + "'" + '; exit 0 ;;\n' +
  '  image:copy)\n' +
  '    if [ "$REGCTL_FIXTURE_FAIL" = "1" ]; then echo "connection reset" >&2; exit 1; fi\n' +
  '    exit 0 ;;\n' +
  'esac\n' +
  'exit 2\n';

function fixture(fail) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-acr-mac-fixture-'));
  try {
    const fake = path.join(tmp, 'regctl');
    fs.writeFileSync(fake, mock, {mode: 0o755});
    const resultDir = path.join(tmp, 'result');
    const entry = fileURLToPath(new URL('./mirror-acr-macos.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [entry, sha, 'server', '5', '1'], {
      encoding: 'utf8',
      timeout: 15000,
      env: {...process.env, PATH: tmp + path.delimiter + process.env.PATH,
        MIRROR_ACR_TEST_ALLOW_PLATFORM: '1',
        MIRROR_RESULT_DIR: resultDir,
        RUNNER_TEMP: tmp,
        GHCR_USERNAME: 'test-user', GHCR_TOKEN: 'test-ghcr-secret',
        ACR_USERNAME: 'test-acr-user', ACR_PASSWORD: 'test-acr-secret',
        GITHUB_REPOSITORY: 'BestNathan/nession', GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1', RUNNER_NAME: 'hs-mac-fixture',
        REGCTL_FIXTURE_FAIL: fail ? '1' : '0'},
    });
    const report = JSON.parse(fs.readFileSync(path.join(resultDir, 'result.json'), 'utf8'));
    assert.equal(report.source_sha, sha);
    assert.equal(report.roles.length, 1);
    assert.ok(report.total_elapsed_seconds >= 0);
    assert.equal(report.roles[0].attempts.length, fail ? 3 : 2);
    assert.ok(!result.stdout.includes('test-ghcr-secret'));
    assert.ok(!result.stdout.includes('test-acr-secret'));
    assert.ok(!result.stderr.includes('test-acr-secret'));
    return {result, report};
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
  assert.ok(report.roles[0].attempts.every(x => x.outcome === 'success'));
});

test('failed copy fails closed but records real attempted time and structured failure artifact', () => {
  const {result, report} = fixture(true);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(report.status, 'failure');
  assert.equal(report.roles[0].status, 'failure');
  assert.equal(report.roles[0].error, 'copy_failed_amd64');
  assert.equal(report.roles[0].attempts.length, 3);
});
