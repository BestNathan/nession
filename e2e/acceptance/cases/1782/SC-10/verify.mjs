// #1782 SC-10: public publication rejects raw Agent payloads, checkpoint
// bytes, credentials, private addressing/paths/hostnames, malicious Issue
// content and unsafe URLs. The security fixtures run at the exact target SHA,
// and the release gate independently rechecks the resulting projection.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProjection, validateProjection } from '../../../../../pages/scripts/project.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const now = '2026-10-22T00:00:00.000Z';
const canonicalUrl = 'https://github.com/BestNathan/nession/issues/1';

function git(...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || 'git command failed');
  return result.stdout.trim();
}

function project(issues = []) {
  return makeProjection({
    repository: null, agent: null, registry: null,
    issues, pulls: null, workflowRuns: null, issueTimelines: null, prReviews: null,
    issueRunSource: null, acceptanceE2E: null, agentStoreSource: null,
    refs: {}, meta: { generated_at: now, main_sha: 'a'.repeat(40) },
  });
}

function entry(title, extra = {}) {
  return { number: 1, title, state: 'open', updated_at: now, ...extra };
}

function titleOf(title) {
  const projection = project([entry(title)]);
  validateProjection(projection);
  return projection.work.issues[0].title;
}

function runSecurityFixtures() {
  const files = [
    'pages/tests/project.test.mjs',
    'pages/tests/lineage.test.mjs',
    'pages/tests/agent-result-candidates.test.mjs',
    'pages/tests/agent-store-readiness.test.mjs',
    'pages/tests/issue-runs.test.mjs',
  ];
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: repo, encoding: 'utf8', timeout: 90000,
  });
  assert.equal(result.status, 0, result.stderr || 'security fixture suite failed');
  const tap = result.stdout;
  const counts = (label) => Number((tap.match(new RegExp('^# ' + label + ' (\\d+)$', 'm')) || [])[1]);
  assert.equal(counts('fail'), 0, 'security fixtures reported a failing test');
  assert.equal(counts('skipped'), 0, 'security fixtures must not skip');
  assert.ok(counts('pass') >= 30, 'security fixture coverage unexpectedly small');
  const ok = [...tap.matchAll(/^ok \d+ - (.+)$/gm)].map((match) => match[1]);
  const required = [
    'strict sanitized/public schema only, source backed URLs',
    'untrusted local address and private file paths are removed before publication',
    'public release gate rejects arbitrary fields, unsafe links and invalid values',
    'public projector prevents forged lineage, private spill and missing source confusion',
  ];
  for (const name of required) {
    assert.ok(ok.includes(name), 'required security fixture is absent: ' + name);
  }
  return { pass: counts('pass'), files: files.length };
}

function main() {
  const sha = process.env.NESSION_ACCEPTANCE_TARGET_SHA || '';
  assert.match(sha, /^[a-f0-9]{40}$/, 'exact target SHA required');
  assert.equal(git('rev-parse', 'HEAD'), sha, 'Case checkout SHA mismatch');

  const fixtures = runSecurityFixtures();

  // Executable negative fixtures against the real projection/sanitizer.
  // HTML/JS never survives as markup.
  const html = titleOf('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /[<>]|onerror/i, 'HTML/JS survived Issue title sanitization');
  // Private network addressing, local paths, private hostnames and credential
  // syntax are redacted before publication.
  for (const value of [
    'server at 10.12.0.7',
    'server at 192.168.1.9',
    'server at 172.20.0.3',
    'worker on build-node.internal',
    'path /Users/admin/secret',
    'token ghp_' + 'a'.repeat(36),
    'api_key=super-secret-value',
    'authorization: bearer value',
  ]) {
    assert.equal(titleOf(value), '[redacted public text]', 'private/credential text not redacted: ' + value);
  }

  // Raw Agent payload keys and non-canonical links are never copied from the
  // untrusted source object into the published projection.
  const rawIssue = entry('safe title', {
    prompt: 'private prompt', tool_arguments: 'raw arguments', tool_results: 'raw result',
    checkpoint_bytes: 'ciphertext', auth_token: 'secret', session_id: 'native-session',
    hostname: 'private-host', html_url: 'https://evil.example/issue/1',
    url: 'https://evil.example/issue/1',
  });
  const projection = project([rawIssue]);
  validateProjection(projection);
  const serialized = JSON.stringify(projection);
  for (const marker of ['private prompt', 'raw arguments', 'raw result', 'ciphertext', 'native-session', 'private-host', 'evil.example']) {
    assert.ok(!serialized.includes(marker), 'private or unsafe source value leaked: ' + marker);
  }
  assert.equal(projection.work.issues[0].url, canonicalUrl, 'Issue URL is not canonical');

  // The release gate rejects forbidden keys/values even if a producer tries to
  // pass them through. None of these fixtures may ever become a Pass.
  const forbiddenFields = ['prompt', 'transcript', 'checkpoint_bytes', 'tool_arguments', 'tool_results', 'auth_token', 'secret', 'private_key', 'env', 'session_id', 'hostname'];
  for (const field of forbiddenFields) {
    const tampered = structuredClone(projection);
    tampered.work.issues[0][field] = 'x';
    assert.throws(() => validateProjection(tampered), /disallowed public field|private field/,
      'forbidden field accepted by release gate: ' + field);
  }
  const privateValue = structuredClone(projection);
  privateValue.work.issues[0].title = 'reach me at 10.0.0.8';
  assert.throws(() => validateProjection(privateValue), /private field value in public projection/,
    'private address accepted by release gate');
  const tokenValue = structuredClone(projection);
  tokenValue.work.issues[0].title = 'ghp_' + 'b'.repeat(36);
  assert.throws(() => validateProjection(tokenValue), /private field value in public projection/,
    'credential marker accepted by release gate');
  const unsafeLink = structuredClone(projection);
  unsafeLink.work.issues[0].url = 'https://evil.example/issue/1';
  assert.throws(() => validateProjection(unsafeLink), /untrusted public URL/,
    'unsafe URL accepted by release gate');

  process.stdout.write(JSON.stringify({
    status: 'pass',
    summary: 'Security fixtures and independent release-gate negatives reject raw Agent payloads, credentials, private addressing/paths/hostnames, malicious markup and unsafe URLs before publication.',
    evidence: [
      { type: 'fixtures', value: fixtures.pass + ' passing security tests across ' + fixtures.files + ' fixture files; zero skip/fail at ' + sha.slice(0, 12) },
      { type: 'sanitize', value: 'HTML/JS stripped; 8 private/credential patterns redacted; 7 raw Agent payload markers absent from the projection' },
      { type: 'release-gate', value: '11 forbidden fields plus private value, credential marker and unsafe URL all rejected' },
      { type: 'source', value: 'canonical_url=' + canonicalUrl },
    ],
  }) + '\n');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message + '\n');
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: message,
    evidence: [{ type: 'security', value: 'publication security negative proof failed at the exact target SHA' }],
  }) + '\n');
  process.exitCode = 1;
}
