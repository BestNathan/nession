'use strict';
// Shared machinery for the #2319 staging Developer Cases.
//
// Each Case reads the public append-only `agent-store` and `metrics` branches
// at an exact staging target. The Case never receives a GitHub, Store or model
// credential. Evidence that does not exist yet is Pending, never a premature
// Fail: the staging push discovers these Cases before a matching seed/resume
// Run can exist, and a Fail would outrank the later source-aligned proof.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetSha } = require('./control-mode-cases.cjs');
const { root: checkoutRoot } = require('./terminal-sizing-cases.cjs');

const REMOTE = 'https://github.com/BestNathan/nession.git';
const ISSUE = 2319;
const IDENTITY_PATH = 'roles/developer/dev-qwen-01/issues/2319';
const WORKFLOW_ID = 'agent-staging-developer-canary';
const WORKFLOW = '.github/workflows/agent-staging-developer-canary.yml';
const SHA = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const QWEN = /^qwen[a-z0-9._-]*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function git(cwd, args, timeout = 180000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    output: String(result.stdout || ''),
    error: String(result.stderr || result.stdout).slice(-3000),
  };
}

function must(cwd, args, timeout) {
  const result = git(cwd, args, timeout);
  if (!result.ok) throw new Error('git ' + args.join(' ') + ' failed: ' + result.error);
  return result.output;
}

function readJson(repo, ref, file) {
  const raw = must(repo, ['show', ref + ':' + file]);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON at ' + ref + ':' + file);
  }
}

function list(repo, ref, prefix) {
  return must(repo, ['ls-tree', '-r', '--name-only', ref, '--', prefix])
    .split('\n')
    .filter(Boolean);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function qwen(value) {
  return typeof value === 'string' && QWEN.test(value);
}

function pending(summary, evidence) {
  return { status: 'pending', summary, evidence };
}

function emit(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'fail') process.exitCode = 1;
}

function withPublicBranches(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-2319-case-'));
  try {
    const repo = path.join(dir, 'ns.git');
    must(dir, ['init', '-q', '--bare', repo]);
    const fetched = git(repo, ['fetch', '-q', '--depth=1', REMOTE,
      'agent-store:refs/ns/agent-store', 'metrics:refs/ns/metrics']);
    if (!fetched.ok) {
      return pending('The public Store/Metrics branches are not reachable yet.',
        [{ type: 'store', value: fetched.error }]);
    }
    const storeRef = must(repo, ['rev-parse', 'refs/ns/agent-store']).trim();
    const metricsRef = must(repo, ['rev-parse', 'refs/ns/metrics']).trim();
    expect(SHA.test(storeRef) && SHA.test(metricsRef),
      'fetched Store refs are not exact commits');
    return fn({ repo, storeRef, metricsRef });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The checkpoint was produced at an earlier staging tip. Prove that tip is in
// this target's history before treating its proof as source-aligned.
// actions/checkout is shallow, so deepen just enough to reach the commit.
function stagedAncestor(source) {
  for (const depth of [20, 100]) {
    const present = git(checkoutRoot, ['cat-file', '-e', source + '^{commit}']);
    if (present.ok) {
      return git(checkoutRoot, ['merge-base', '--is-ancestor', source, 'HEAD']).ok;
    }
    if (!git(checkoutRoot, ['fetch', '-q', '--deepen=' + depth, 'origin']).ok) {
      return null;
    }
  }
  const present = git(checkoutRoot, ['cat-file', '-e', source + '^{commit}']);
  return present.ok
    ? git(checkoutRoot, ['merge-base', '--is-ancestor', source, 'HEAD']).ok
    : null;
}

function loadCheckpoint({ repo, storeRef }, sha) {
  const headFile = IDENTITY_PATH + '/head.json';
  if (!list(repo, storeRef, IDENTITY_PATH).includes(headFile)) {
    return pending(
      'The staging Developer Store has no committed checkpoint for this identity yet.',
      [{ type: 'store', value: 'agent-store ' + storeRef + ': missing ' + headFile }],
    );
  }
  const head = readJson(repo, storeRef, headFile);
  expect(positive(head.version), 'Store head version is not a positive integer');
  expect(head.checkpoint_path ===
    IDENTITY_PATH + '/checkpoints/' + String(head.version).padStart(8, '0') + '.json',
  'Store head does not name the canonical checkpoint path');
  expect(HEX64.test(head.ciphertext_sha256 ?? ''),
    'Store head ciphertext digest is not 64 hex');
  const checkpoint = readJson(repo, storeRef, head.checkpoint_path);
  expect(checkpoint.kind === 'encrypted_agent_checkpoint' &&
    checkpoint.schema_version === 1, 'committed object is not an encrypted checkpoint');
  expect(checkpoint.path === head.checkpoint_path, 'checkpoint path differs from the Store head');
  expect(checkpoint.version === head.version, 'checkpoint version differs from the Store head');
  expect(JSON.stringify(checkpoint.identity) === JSON.stringify({
    role: 'developer', agent_id: 'dev-qwen-01', issue: ISSUE,
  }), 'checkpoint identity is not the staging Developer identity');
  expect(checkpoint.metadata?.provider === 'claude-code',
    'checkpoint provider is not claude-code');
  expect(HEX64.test(checkpoint.metadata?.harness_digest ?? ''),
    'checkpoint harness digest is not 64 hex');
  expect(checkpoint.encryption?.algorithm === 'aes-256-gcm',
    'checkpoint encryption is not AES-256-GCM');
  const ciphertext = Buffer.from(checkpoint.ciphertext ?? '', 'base64');
  const digest = crypto.createHash('sha256').update(ciphertext).digest('hex');
  expect(digest === checkpoint.ciphertext_sha256,
    'checkpoint ciphertext does not hash to its declared digest');
  expect(checkpoint.ciphertext_sha256 === head.ciphertext_sha256,
    'checkpoint ciphertext digest differs from the Store head');
  expect(SHA.test(checkpoint.metadata?.source_sha ?? ''),
    'checkpoint source SHA is not an exact commit');
  return {
    head,
    checkpoint,
    source_sha: checkpoint.metadata.source_sha,
    ciphertext_sha256: checkpoint.ciphertext_sha256,
  };
}

function loadSeedRun({ repo, storeRef }, commitment) {
  const matches = list(repo, storeRef, IDENTITY_PATH + '/runs')
    .map((file) => readJson(repo, storeRef, file))
    .filter((record) => record?.checkpoint_path === commitment.head.checkpoint_path &&
      record?.version === commitment.head.version &&
      record?.ciphertext_sha256 === commitment.head.ciphertext_sha256);
  if (matches.length === 0) {
    return pending('The Store has no Run record for the current committed checkpoint yet.',
      [{ type: 'store', value: 'agent-store ' + storeRef + ': checkpoint v' +
        commitment.head.version + ' has no Run record' }]);
  }
  expect(matches.length === 1,
    'expected exactly one Store Run record for the current checkpoint, found ' + matches.length);
  const record = matches[0];
  expect(record.kind === 'agent_checkpoint_run' && record.schema_version === 1,
    'Store Run record is not a canonical checkpoint run');
  expect(record.role === 'developer' && record.agent_id === 'dev-qwen-01' &&
    record.issue === ISSUE, 'Store Run record has the wrong identity');
  expect(positive(record.run_id) && record.attempt === 1,
    'Store Run record does not name one exact Run/Attempt');
  expect(record.workflow === WORKFLOW, 'Store Run record names a different workflow');
  expect(record.source_sha === commitment.source_sha,
    'Store Run record is not bound to the checkpoint source SHA');
  expect(record.harness_digest === commitment.checkpoint.metadata.harness_digest,
    'Store Run harness digest differs from the checkpoint');
  return record;
}

function loadTelemetry({ repo, metricsRef }) {
  const listed = git(repo, ['ls-tree', '-r', '--name-only', metricsRef, '--',
    'raw/workflows/' + WORKFLOW_ID]);
  if (!listed.ok) {
    return pending('The append-only Metrics branch is not readable yet.',
      [{ type: 'store', value: 'metrics ' + metricsRef + ': ' + listed.error }]);
  }
  return listed.output.split('\n').filter(Boolean)
    .map((file) => readJson(repo, metricsRef, file))
    .filter((record) => record?.kind === 'agent_workflow_run' &&
      record?.task?.issue === ISSUE &&
      record?.identity?.workflow_id === WORKFLOW_ID);
}

module.exports = {
  ISSUE, IDENTITY_PATH, WORKFLOW, SHA, HEX64, UUID,
  targetSha, expect, positive, qwen, pending, emit,
  withPublicBranches, stagedAncestor, loadCheckpoint, loadSeedRun, loadTelemetry,
};
