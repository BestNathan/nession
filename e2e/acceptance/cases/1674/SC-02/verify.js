'use strict';

const assert = require('node:assert/strict');
const { runtimeFromEnv, verifyOnlineAgent } =
  require('../../../shared/protocol-online-agent.js');

async function main() {
  const runtime = runtimeFromEnv();
  const targetSha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(targetSha, /^[0-9a-f]{40}$/i);
  assert.equal(runtime.target_sha, targetSha, 'runtime must match exact accepted source SHA');
  assert.equal(runtime.profile, 'full-stack-local');

  const online = await verifyOnlineAgent(runtime);
  assert.equal(online.status, 'pass', 'live Server/Agent online registration must pass');
  assert.ok(Array.isArray(online.evidence) && online.evidence.length > 0,
    'online Agent proof needs observable protocol evidence');
  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'Authenticated real Server + live Agent registration on exact merged SHA',
    evidence: online.evidence,
  }) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(message).slice(0, 1200),
    evidence: [{ type: 'runtime', value: 'failed live Agent protocol proof' }],
  }) + '\n');
  process.exitCode = 1;
});
