'use strict';
const assert = require('node:assert/strict');
const { runtimeFromEnv, verifyOnlineAgent } = require('../../../shared/protocol-online-agent.js');

async function main() {
  const runtime = runtimeFromEnv();
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(sha || '', /^[0-9a-f]{40}$/, 'acceptance must pin exact target SHA');
  assert.equal(runtime.target_sha, sha, 'runtime target SHA drift');
  const result = await verifyOnlineAgent(runtime);
  assert.equal(result.status, 'pass');
  result.summary = 'Canonical Acceptance layout verified against a real Server/Agent on the pinned staging SHA.';
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail', summary: message,
    evidence: [{ type: 'protocol', value: 'real Server/Agent protocol verification failed' }],
  }) + '\n');
  process.exitCode = 1;
});
