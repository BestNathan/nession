'use strict';
// #1664 SC-06: exact source checkout + live encrypted agent-store history,
// exercised together with the existing production Store CAS/privacy fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../../../../..');
const issue = 1997;
const id = 'roles/developer/dev-cursor-01/issues/' + issue;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SOURCE_SHA = '220266b9233ec97b1beacbc54e5cc7f82d3cece2';
const V1_COMMIT = 'd812e3655c0ad6337b1003aa0c1794c12335adb0';
const V2_COMMIT = 'f9abdeca3cc26780fb0a7b2ed7000d2dd28cf142';
const V3_COMMIT = 'eb891ee2154d02ddb758d50f0f694e70a343ffdf';
const V2_DIGEST = 'ae089e6b7b1743a9afdb78814ba716be024ccde9da0a1ddfbc965601f2691f1e';
const V3_DIGEST = '7afed3f229d371b850fda3fcc77fb0f601f2c588ccab6210d878b2f7501321a0';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
}
function at(directory, revision, relative) {
  const raw = git(directory, 'show', revision + ':' + relative);
  const parsed = JSON.parse(raw);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  return parsed;
}
function checkpoint(store, commit, version, digest) {
  const location = id + '/checkpoints/' + String(version).padStart(8, '0') + '.json';
  const record = at(store, commit, location);
  const head = at(store, commit, id + '/head.json');
  assert.deepEqual(Object.keys(record).sort(), [
    'ciphertext', 'ciphertext_sha256', 'encryption', 'identity', 'kind',
    'metadata', 'path', 'schema_version', 'version',
  ]);
  assert.equal(record.kind, 'encrypted_agent_checkpoint');
  assert.equal(record.schema_version, 1);
  assert.equal(record.version, version);
  assert.equal(record.path, location);
  assert.deepEqual(record.identity, { role: 'developer', agent_id: 'dev-cursor-01', issue });
  assert.equal(record.metadata.provider, 'cursor');
  assert.equal(record.metadata.source_sha, SOURCE_SHA);
  assert.match(record.metadata.harness_digest, HASH);
  assert.equal(record.encryption.algorithm, 'aes-256-gcm');
  assert.ok(Buffer.from(record.encryption.iv, 'base64').length === 12);
  assert.ok(Buffer.from(record.encryption.tag, 'base64').length === 16);
  assert.match(record.ciphertext_sha256, HASH);
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  assert.ok(ciphertext.length > 0);
  assert.equal(ciphertext.toString('base64'), record.ciphertext);
  assert.equal(sha256(ciphertext), record.ciphertext_sha256);
  if (digest) assert.equal(record.ciphertext_sha256, digest);
  assert.equal(head.version, version);
  assert.equal(head.checkpoint_path, location);
  assert.equal(head.ciphertext_sha256, record.ciphertext_sha256);
  return { location, ciphertext_sha256: record.ciphertext_sha256 };
}
function localFixture(relative, ...args) {
  execFileSync(process.execPath, [relative, ...args], {
    cwd: repo, timeout: 180000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function main() {
  const target = process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target, SHA, 'Case requires an exact source SHA');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), target, 'Case source checkout drift');
  // Case checkout is intentionally shallow. The committed checkpoint metadata
  // pins SOURCE_SHA; do not infer its ancestry from an unavailable local history.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-1664-sc06-'));
  try {
    const store = path.join(tmp, 'agent-store');
    execFileSync('git', [
      'clone', '--quiet', '--no-tags', '--single-branch', '--branch', 'agent-store', '--',
      'https://github.com/BestNathan/nession.git', store,
    ], { timeout: 90000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
    assert.equal(git(store, 'symbolic-ref', '--short', 'HEAD'), 'agent-store');
    const tip = git(store, 'rev-parse', 'HEAD');
    assert.match(tip, SHA);
    git(store, 'merge-base', '--is-ancestor', V1_COMMIT, V2_COMMIT);
    git(store, 'merge-base', '--is-ancestor', V2_COMMIT, V3_COMMIT);
    git(store, 'merge-base', '--is-ancestor', V3_COMMIT, tip);
    const v1 = checkpoint(store, V1_COMMIT, 1);
    const v2 = checkpoint(store, V2_COMMIT, 2, V2_DIGEST);
    const v3 = checkpoint(store, V3_COMMIT, 3, V3_DIGEST);
    assert.notEqual(v1.ciphertext_sha256, v2.ciphertext_sha256);
    assert.notEqual(v2.ciphertext_sha256, v3.ciphertext_sha256);
    const currentHead = at(store, tip, id + '/head.json');
    assert.ok(currentHead.version >= 3, 'committed native history was reset');
    assert.match(currentHead.ciphertext_sha256, HASH);
    const historical = at(store, tip, 'workflows/issues/1997/states/00000015.json');
    assert.equal(historical.version, 15);
    assert.equal(historical.issue, issue);
    const outbox = historical.outbox.filter(x =>
      x.id === 'dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].receipt.source_run_id, 39448549052);
    assert.equal(outbox[0].status, 'dispatched');
    const yielded = at(store, tip, 'workflows/issues/1997/states/00000016.json');
    assert.equal(yielded.version, 16);
    assert.equal(yielded.issue, issue);
    const completed = yielded.outbox.filter(x => x.id === outbox[0].id);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].status, 'yielded');
    assert.equal(completed[0].receipt.source_run_id, 39448549052);
    assert.equal(completed[0].receipt.source_attempt, 1);
    assert.equal(completed[0].receipt.checkpoint_version, 3);
    assert.equal(completed[0].receipt.checkpoint_commit_sha, V3_COMMIT);
    assert.equal(completed[0].receipt.ciphertext_sha256, V3_DIGEST);
    const successors = yielded.outbox.filter(x => x.task.continuation?.parent_action_id === outbox[0].id);
    assert.equal(successors.length, 1);
    assert.equal(successors[0].task.continuation.checkpoint_version, 3);
    assert.equal(successors[0].task.continuation.checkpoint_commit_sha, V3_COMMIT);
    assert.equal(successors[0].status, 'pending');
    // Actual disposable Git remotes: no-force CAS, idempotent replay,
    // distinct parallel IDs, same-key conflict, immutable history, stale
    // writers, wrong-key decryption and known-secret plaintext absence.
    localFixture('scripts/lib/agent/store/remote-selftest.mjs');
    localFixture('scripts/run-store-agent-disposable-selftest.mjs');
    localFixture('scripts/run-store-cas-matrix.mjs', 'self-test');
    console.log(JSON.stringify({ status: 'pass',
      summary: 'Live public orphan Cursor v1/v2/v3 encrypted checkpoint, authenticated ordinal-2 Yield and immutable history verified with isolated remote CAS/replay/privacy negatives.',
      evidence: [
        { type: 'runtime', value: 'exact case/main SHA=' + target },
        { type: 'runtime', value: 'public orphan agent-store tip=' + tip },
        { type: 'runtime', value: 'verified v1 commit=' + V1_COMMIT },
        { type: 'runtime', value: 'verified v2 commit=' + V2_COMMIT + ' ciphertext_sha256=' + V2_DIGEST },
        { type: 'runtime', value: 'verified v3 commit=' + V3_COMMIT + ' ciphertext_sha256=' + V3_DIGEST },
        { type: 'runtime', value: 'verified #1997 v16 / Worker 39448549052-1 yielded exact v3 encrypted checkpoint; one pending successor' },
        { type: 'runtime', value: 'historical #1997 v15 dispatched Worker 39448549052 retained' },
        { type: 'runtime', value: 'disposable Git CAS/replay/immutability and encrypted known-secret privacy fixtures passed' },
      ],
    }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ status: 'fail', summary: message,
    evidence: [{ type: 'runtime', value: 'SC-06 public Git/CAS verification failed' }],
  }));
  process.exitCode = 1;
});
