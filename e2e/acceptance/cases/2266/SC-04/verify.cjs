'use strict';
// #2266 SC-04: an already dispatched durable Developer task keeps its original
// provider/model when the Environment default changes, and resumes from the
// committed encrypted Session rather than a new Run's default.
//
// This Case reads two public append-only branches at the exact staging target:
//   - agent-store: the committed encrypted checkpoint and the Run that wrote it
//   - metrics: the canonical seed/resume telemetry of that checkpoint's Runs
// SC-04's deterministic configuration matrix is pre-merge evidence owned by the
// model-selection and dispatch selftests; this Case owns the behavioral claim
// that a merged staging target retains the dispatched model across resume.
// No GitHub or model credential is used.
//
// Evidence that does not exist yet at this target is Pending, not Fail: the
// staging push discovers this Case before the seed/resume Runs can exist, and
// a Fail would permanently outrank the later source-aligned proof.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { targetSha } = require('../../../shared/control-mode-cases.cjs');
const { root: checkoutRoot } = require('../../../shared/terminal-sizing-cases.cjs');

const REMOTE = 'https://github.com/BestNathan/nession.git';
const ISSUE = 2319;
const IDENTITY = 'roles/developer/dev-qwen-01/issues/2319';
const WORKFLOW_ID = 'agent-staging-developer-canary';
const WORKFLOW = '.github/workflows/agent-staging-developer-canary.yml';
const SHA = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const QWEN = /^qwen[a-z0-9._-]*$/i;

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

function isQwen(value) {
  return typeof value === 'string' && QWEN.test(value);
}

function pending(summary, evidence) {
  return { status: 'pending', summary, evidence };
}

// The checkpoint was produced at an earlier staging tip. Prove that tip is
// still in this target's history before treating its proof as source-aligned.
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

function loadCommitment(repo, storeRef, sha) {
  const headFile = IDENTITY + '/head.json';
  const listed = list(repo, storeRef, IDENTITY);
  if (!listed.includes(headFile)) {
    return pending(
      'The staging Developer Store has no committed checkpoint for this identity yet; the seed Run has not published one.',
      [{ type: 'store', value: 'agent-store ' + storeRef + ': missing ' + headFile }],
    );
  }
  const head = readJson(repo, storeRef, headFile);
  expect(positive(head.version), 'Store head version is not a positive integer');
  expect(head.checkpoint_path ===
    IDENTITY + '/checkpoints/' + String(head.version).padStart(8, '0') + '.json',
  'Store head does not name the canonical checkpoint path');
  expect(HEX64.test(head.ciphertext_sha256 ?? ''),
    'Store head ciphertext digest is not 64 hex');
  const checkpoint = readJson(repo, storeRef, head.checkpoint_path);
  expect(checkpoint.kind === 'encrypted_agent_checkpoint' &&
    checkpoint.schema_version === 1, 'committed object is not an encrypted checkpoint');
  expect(checkpoint.path === head.checkpoint_path, 'checkpoint path differs from the Store head');
  expect(checkpoint.version === head.version, 'checkpoint version differs from the Store head');
  expect(JSON.stringify(checkpoint.identity) ===
    JSON.stringify({ role: 'developer', agent_id: 'dev-qwen-01', issue: ISSUE }),
  'checkpoint identity is not the staging Developer identity');
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

function loadSeedRun(repo, storeRef, commitment) {
  const matches = list(repo, storeRef, IDENTITY + '/runs')
    .map((file) => readJson(repo, storeRef, file))
    .filter((record) => record?.checkpoint_path === commitment.head.checkpoint_path &&
      record?.version === commitment.head.version &&
      record?.ciphertext_sha256 === commitment.head.ciphertext_sha256);
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
  expect(record.source_sha === commitment.checkpoint.metadata.source_sha,
    'Store Run record is not bound to the checkpoint source SHA');
  expect(record.harness_digest === commitment.checkpoint.metadata.harness_digest,
    'Store Run harness digest differs from the checkpoint');
  return record;
}

function loadTelemetry(repo, metricsRef) {
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

function verify(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-2266-sc04-'));
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

    const commitment = loadCommitment(repo, storeRef, sha);
    if (commitment.status === 'pending') return commitment;
    const source = commitment.source_sha;
    const ancestry = stagedAncestor(source);
    if (ancestry === null) {
      return pending(
        'The Git history needed to prove checkpoint source ' + source +
        ' is in this staging target is not available yet.',
        [{
          type: 'store',
          value: 'agent-store ' + storeRef + ': checkpoint v' + commitment.head.version +
            ' source ' + source + ' (target ' + sha + ')',
        }],
      );
    }
    if (ancestry === false) {
      return pending(
        'The committed checkpoint is bound to ' + source +
        ', which is not in this staging target history; this SHA has no source-aligned seed.',
        [{
          type: 'store',
          value: 'agent-store ' + storeRef + ': checkpoint v' + commitment.head.version +
            ' source ' + source + ' not an ancestor of ' + sha,
        }],
      );
    }
    const seedRun = loadSeedRun(repo, storeRef, commitment);
    const records = loadTelemetry(repo, metricsRef);
    if (records.status === 'pending') return records;

    const seed = records.filter((record) =>
      record.identity.github_run_id === seedRun.run_id);
    if (seed.length === 0) {
      return pending(
        'The seed Run ' + seedRun.run_id + ' telemetry has not been ingested yet, so the checkpoint cannot be tied to a real provider call.',
        [{
          type: 'store',
          value: 'agent-store ' + storeRef + ': checkpoint v' + commitment.head.version +
            ' seed run ' + seedRun.run_id,
        }],
      );
    }
    expect(seed.length === 1,
      'expected one seed telemetry record for Run ' + seedRun.run_id + ', found ' + seed.length);
    const model = seed[0].agent?.model?.id;
    expect(isQwen(model), 'seed Run did not record a Qwen model');
    expect(seed[0].task?.target_ref === source,
      'seed telemetry is not bound to the exact staging target SHA');
    expect(seed[0].result?.status === 'staging-canary-pass',
      'seed Run did not pass the staging canary');

    const resumes = records.filter((record) =>
      record.task?.phase === 'resume' &&
      record.task?.checkpoint_version === commitment.head.version &&
      record.task?.checkpoint_ciphertext_sha256 === commitment.ciphertext_sha256);
    if (resumes.length === 0) {
      return pending(
        'No resume Run is yet bound to committed checkpoint v' +
        commitment.head.version + ' at this staging SHA.',
        [{
          type: 'store',
          value: 'agent-store ' + storeRef + ': checkpoint v' + commitment.head.version +
            ' ciphertext ' + commitment.ciphertext_sha256 + '; no bound resume telemetry',
        }],
      );
    }
    for (const record of resumes) {
      expect(positive(record.identity.github_run_id) &&
        record.identity.github_run_id > seedRun.run_id,
      'a bound resume Run is not later than the seed Run');
      expect(record.task?.target_ref === source,
        'resume telemetry is not bound to the exact staging target SHA');
      expect(record.agent?.model?.id === model,
        'resume Run changed the already dispatched model ' + model +
        ' to ' + record.agent?.model?.id);
      expect(record.result?.status === 'staging-canary-pass',
        'resume Run ' + record.identity.github_run_id + ' did not pass');
    }
    const switched = resumes.filter((record) =>
      isQwen(record.task?.dispatched_default_model) &&
      record.task.dispatched_default_model !== model);
    if (switched.length === 0) {
      return pending(
        'The resume Runs kept default model ' + model +
        ', so no default switch has been exercised for this checkpoint yet.',
        [{ type: 'telemetry', value: 'seed and resume both used model ' + model }],
      );
    }
    const resumed = switched[switched.length - 1];
    const defaultModel = resumed.task.dispatched_default_model;

    const evidence = [
      {
        type: 'runtime',
        value: 'exact staging target ' + sha + ': checkpoint source ' + source +
          ' is an ancestor of the target; authenticated Store checkpoint and ' +
          'seed/resume canary telemetry read from the public append-only branches',
      },
      {
        type: 'store',
        value: 'agent-store ' + storeRef + ': checkpoint v' + commitment.head.version +
          ' ' + commitment.head.checkpoint_path + ' ciphertext ' +
          commitment.ciphertext_sha256 + ' provider claude-code source ' +
          commitment.checkpoint.metadata.source_sha + ' harness ' +
          commitment.checkpoint.metadata.harness_digest,
      },
      {
        type: 'telemetry',
        value: 'seed Run ' + seedRun.run_id + ' (dispatch ' +
          seed[0].task.dispatch_id + ') model ' + model +
          ' result staging-canary-pass target ' + seed[0].task.target_ref,
      },
      {
        type: 'telemetry',
        value: 'resume Run ' + resumed.identity.github_run_id + ' (dispatch ' +
          resumed.task.dispatch_id + ') kept model ' + model +
          ' while dispatched default was ' + defaultModel +
          '; checkpoint v' + resumed.task.checkpoint_version + ' ' +
          resumed.task.checkpoint_ciphertext_sha256 +
          '; result staging-canary-pass',
      },
    ];
    return {
      status: 'pass',
      summary: 'Staging Developer work dispatched with ' + model +
        ' kept that model when the Environment default became ' + defaultModel +
        ' and resumed from committed checkpoint v' + commitment.head.version,
      evidence,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const result = verify(targetSha());
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status === 'fail') process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: 'fail',
    summary: String(error && error.message ? error.message : error).slice(-4400),
    evidence: [{ type: 'runtime', value: 'the staging checkpoint and resume receipts could not be authenticated' }],
  }) + '\n');
  process.exitCode = 1;
}
