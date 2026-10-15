'use strict';
// #1828 SC-01: a real post-merge, source-aligned Case producer.
// This verifier is strictly read-only. The *later* trusted Case Ingest
// and independent Receipt Readback, not the verifier, establish a real write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyOnlineAgent, runtimeFromEnv } =
  require('../../../shared/protocol-online-agent.js');

const root = path.resolve(__dirname, '../../../../..');
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;

function validateSource(env, checkoutSha) {
  assert.match(String(env.NESSION_ACCEPTANCE_TARGET_SHA || ''), hex40, 'exact source SHA required');
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'real main Push required');
  assert.equal(env.GITHUB_REF_NAME, 'main', 'source must be main');
  assert.equal(env.GITHUB_SHA, env.NESSION_ACCEPTANCE_TARGET_SHA, 'source workflow SHA mismatch');
  assert.equal(checkoutSha, env.NESSION_ACCEPTANCE_TARGET_SHA, 'target checkout SHA mismatch');
  assert.match(String(env.NESSION_ACCEPTANCE_CONTRACT_SHA256 || ''), hex64,
    'canonical signed-by-workflow Case contract digest required');
  assert.ok(Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) && Number(env.GITHUB_RUN_ID) > 0,
    'real Actions source run ID required');
}

function validateTrustedPipeline(ingest, readback) {
  assert.match(ingest, /workflows:\s*\["Acceptance \/ Cases"\]/,
    'Case Ingest must only ingest its named source');
  assert.match(ingest, /ref:\s*main\s*\n\s*path:\s*trusted/,
    'ingester tooling must use trusted main');
  assert.match(ingest, /actions\/create-github-app-token@/,
    'ingester must support scoped App identity');
  assert.match(ingest, /run-store-cas-push\.mjs/,
    'ingester must use normal CAS publication');
  assert.match(ingest, /run-store-receipt-verify\.mjs/,
    'ingester must postverify Git bytes');
  assert.match(readback, /- "Acceptance \/ Case Ingest"/,
    'independent consumer must subscribe to Case Ingest');
  assert.match(readback, /permissions:\s*\n\s*actions:\s*read\s*\n\s*contents:\s*read/,
    'independent readback must be read-only');
  assert.match(readback, /run-store-receipt-live\.mjs verify/,
    'consumer must reauthenticate and verify receipt bytes');
  assert.doesNotMatch(readback, /permission-contents:\s*write/,
    'consumer must never mint writer permissions');
}

function test() {
  const sha = 'a'.repeat(40);
  const env = {
    NESSION_ACCEPTANCE_TARGET_SHA: sha,
    NESSION_ACCEPTANCE_CONTRACT_SHA256: 'b'.repeat(64),
    GITHUB_SHA: sha, GITHUB_EVENT_NAME: 'push',
    GITHUB_REF_NAME: 'main', GITHUB_RUN_ID: '123',
  };
  validateSource(env, sha);
  for (const patch of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF_NAME: 'other' },
    { GITHUB_SHA: 'c'.repeat(40) },
    { NESSION_ACCEPTANCE_CONTRACT_SHA256: 'bad' },
    { GITHUB_RUN_ID: '0' },
  ]) assert.throws(() => validateSource({ ...env, ...patch }, sha));
  assert.throws(() => validateSource(env, 'c'.repeat(40)));
  const ingest = fs.readFileSync(path.join(root, '.github/workflows/acceptance-case-ingest.yml'), 'utf8');
  const readback = fs.readFileSync(path.join(root, '.github/workflows/store-receipt-readback.yml'), 'utf8');
  validateTrustedPipeline(ingest, readback);
  assert.throws(() => validateTrustedPipeline(ingest.replace('ref: main', 'ref: arbitrary'), readback));
  assert.throws(() => validateTrustedPipeline(ingest.replace('run-store-cas-push.mjs', 'unsafe-push'), readback));
  assert.throws(() => validateTrustedPipeline(ingest, readback.replace('contents: read', 'contents: write')));
  console.log('Case source identity and read-only App/CAS/readback wiring negatives passed');
}

async function verify() {
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  }).trim();
  validateSource(process.env, checkoutSha);
  const ingest = fs.readFileSync(path.join(root, '.github/workflows/acceptance-case-ingest.yml'), 'utf8');
  const readback = fs.readFileSync(path.join(root, '.github/workflows/store-receipt-readback.yml'), 'utf8');
  validateTrustedPipeline(ingest, readback);
  const runtime = runtimeFromEnv();
  assert.equal(runtime.target_sha, checkoutSha, 'runtime must be exact main SHA');
  assert.equal(runtime.profile, 'full-stack-local', 'real isolated runtime required');
  const online = await verifyOnlineAgent(runtime);
  assert.equal(online.status, 'pass', 'real Server/Agent protocol verification required');
  const response = await fetch(runtime.base_url + '/', { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'real Web runtime did not respond HTTP 200');
  return {
    status: 'pass',
    summary: 'Exact main SHA ran a live Server/Agent/Web Acceptance Case and source-bound trusted Case App/CAS/readback wiring is intact. Only later ingester and separate consumer can prove an actual orphan write.',
    evidence: [
      { type: 'source', value: 'real main push run=' + process.env.GITHUB_RUN_ID + ' target_sha=' + checkoutSha },
      { type: 'contract', value: 'case_contract_sha256=' + process.env.NESSION_ACCEPTANCE_CONTRACT_SHA256 },
      ...online.evidence,
      { type: 'runtime', value: 'isolated Web HTTP status=' + response.status },
      { type: 'trust', value: 'trusted main-only Case Ingest has scoped App + CAS + Git-byte postverify; consumer is a separate read-only Workflow' },
      { type: 'boundary', value: 'this source Case is not proof of successful later ingestion, denied writes, Ruleset enforcement, or external WORM checkpoint' },
    ],
  };
}

if (process.argv.includes('--self-test')) test();
else verify().then(result => {
  console.log(JSON.stringify(result));
}).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({
    status: 'fail', summary: message,
    evidence: [{ type: 'runtime', value: 'source, runtime, or trusted pipeline attestation failed' }],
  }));
  process.exitCode = 1;
});
