#!/usr/bin/env node
// Trusted-only, versioned evidence locator. This is NOT a hash of the
// GitHub artifact ZIP: sha256 covers the validated source record JSON.
import assert from 'node:assert/strict';

const modes = Object.freeze({
  acceptance: { prefix: 'acceptance-case-results', retention_days: 90 },
  scenario: { prefix: 'e2e-terminal-scenario', retention_days: 14 },
});
function requireNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(label + ' must be positive integer');
  return value;
}
export function artifactEvidence({ mode, run_id, run_attempt, source_record_sha256, workflow_url }) {
  const config = modes[mode];
  if (!config) throw new Error('unsupported record artifact mode');
  const runId = requireNumber(run_id, 'run_id');
  const attempt = requireNumber(run_attempt, 'run_attempt');
  if (!/^[0-9a-f]{64}$/.test(source_record_sha256 ?? '')) {
    throw new Error('source record digest must be sha256 hex');
  }
  if (workflow_url !== 'https://github.com/BestNathan/nession/actions/runs/' + runId) {
    throw new Error('artifact source workflow URL does not match authenticated run');
  }
  return {
    schema_version: 1,
    mode,
    provider: 'github-actions-artifact',
    artifact_name: config.prefix + '-' + runId + '-' + attempt,
    sha256: source_record_sha256,
    digest_scope: 'validated-source-record-json',
    retention_days: config.retention_days,
    retrieval_url: workflow_url,
    durability: 'time-limited; object archival not configured',
  };
}
export function validateArtifactEvidence(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('missing artifact evidence envelope');
  }
  const expected = artifactEvidence(context);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error('artifact evidence provenance, digest or retention mismatch');
  }
  return expected;
}
function selfTest() {
  let tested = 0;
  for (const mode of ['acceptance', 'scenario']) {
    const input = { mode, run_id: 112, run_attempt: 2,
      source_record_sha256: 'a'.repeat(64),
      workflow_url: 'https://github.com/BestNathan/nession/actions/runs/112' };
    const proof = artifactEvidence(input);
    assert.equal(validateArtifactEvidence(proof, input).sha256, 'a'.repeat(64)); tested++;
    assert.equal(proof.digest_scope, 'validated-source-record-json');
    assert.match(proof.durability, /time-limited/);
    assert.throws(() => validateArtifactEvidence({ ...proof, retention_days: 99999 }, input),
      /mismatch/); tested++;
    assert.throws(() => validateArtifactEvidence({ ...proof, sha256: 'b'.repeat(64) }, input),
      /mismatch/); tested++;
    assert.throws(() => artifactEvidence({ ...input, workflow_url: input.workflow_url + '/attacker' }),
      /URL/); tested++;
    assert.throws(() => artifactEvidence({ ...input, source_record_sha256: 'forged' }),
      /sha256/); tested++;
  }
  assert.throws(() => artifactEvidence({ mode: 'test' }), /unsupported/); tested++;
  console.log('record artifact evidence contract: ' + tested + ' positive/negative fixtures passed');
}
if (process.argv[1]?.endsWith('run-record-artifact-evidence.mjs') &&
    process.argv[2] === 'self-test') selfTest();
