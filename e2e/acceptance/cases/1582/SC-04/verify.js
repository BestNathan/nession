'use strict';
// #1582 SC-04: exact-main-SHA post-merge, independently observable Task archive.
// Runtime verifier has READ ONLY permissions. No Task script execution or Issue write.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../../..');
const repo = 'BestNathan/nession';
const runs = [
  { id: 38024769923, sha: 'adfeefb13a2b1f64f8f6df19a9f5ef1899c4885c' },
  { id: 38025416466, sha: '61c3fae9c55d0eba9974526c90d481450e77e1a3' },
];
const hex40 = /^[a-f0-9]{40}$/;
const hex64 = /^[a-f0-9]{64}$/;

function sourceDigest(snapshot) {
  assert.equal(snapshot.schema_version, 1);
  assert.ok(Array.isArray(snapshot.files) && snapshot.files.length > 0 && snapshot.files.length <= 32);
  const names = snapshot.files.map(x => x.path);
  assert.deepEqual(names, [...names].sort((a,b) => a.localeCompare(b)), 'source files must be canonical');
  assert.equal(new Set(names).size, names.length, 'duplicate source paths forbidden');
  const hash = crypto.createHash('sha256');
  let total = 0;
  for (const file of snapshot.files) {
    assert.match(file.path, /^[a-zA-Z0-9._/-]+$/, 'invalid source path');
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.match(file.base64, /^[a-zA-Z0-9+/]*={0,2}$/, 'noncanonical source encoding');
    const bytes = Buffer.from(file.base64, 'base64');
    assert.equal(bytes.toString('base64'), file.base64, 'invalid base64');
    total += bytes.length;
    hash.update(file.path, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  assert.ok(total <= 262144, 'oversized Task snapshot');
  return hash.digest('hex');
}

function validateArchive({ record, snapshot, index, run }, expected) {
  const key = String(expected.id) + '-1';
  assert.equal(run.id, expected.id);
  assert.equal(run.name, 'Ephemeral Task Runner');
  assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'task/1582-smoke');
  assert.equal(run.head_sha, expected.sha);
  assert.equal(run.head_repository?.full_name, repo);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(record.schema_version, 1);
  assert.equal(record.trust, 'untrusted-task-observation');
  assert.equal(record.provenance, 'github-workflow-run-and-independent-exact-source');
  assert.equal(record.task_id, '1582-smoke');
  assert.equal(record.source_sha, expected.sha);
  assert.match(record.source_digest, hex64);
  assert.equal(record.entry, 'smoke.mjs');
  assert.equal(record.workflow.id, expected.id);
  assert.equal(record.workflow.attempt, 1);
  assert.equal(record.workflow.event, 'push');
  assert.equal(record.workflow.branch, 'task/1582-smoke');
  assert.equal(record.workflow.conclusion, run.conclusion);
  assert.equal(record.execution.status, 'Success');
  assert.equal(record.execution.exit_code, 0);
  assert.equal(record.acceptance_result, null, 'Task result must never grant Acceptance Pass');
  assert.equal(record.source_snapshot_path, 'sources/' + expected.sha + '/1582-smoke.json');
  assert.equal(record.execution.result?.task_id, '1582-smoke');
  assert.equal(record.execution.result?.source_sha, expected.sha);
  assert.equal(record.execution.result?.observed, true);
  assert.equal(record.execution.result?.marker, 'separate-task-results');

  assert.equal(snapshot.task_id, record.task_id);
  assert.equal(snapshot.source_sha, record.source_sha);
  assert.equal(snapshot.source_digest, record.source_digest);
  assert.equal(sourceDigest(snapshot), record.source_digest, 'source snapshot digest mismatch');
  const manifest = snapshot.files.find(x => x.path === 'task.json');
  assert.ok(manifest, 'snapshot must include Task manifest');
  const config = JSON.parse(Buffer.from(manifest.base64, 'base64').toString('utf8'));
  assert.equal(config.id, record.task_id);
  assert.equal(config.entry, record.entry);
  assert.equal(config.schema_version, 1);
  assert.equal(record.cleanup_on_success, config.cleanup_on_success === true,
    'trusted archive must retain optional cleanup policy without inventing it');

  assert.equal(index.task_id, record.task_id);
  assert.equal(index.source_sha, expected.sha);
  assert.equal(index.run_id, expected.id);
  assert.equal(index.run_attempt, 1);
  assert.equal(index.record_path, 'runs/1582-smoke/' + key + '/record.json');
  assert.equal(index.source_path, record.source_snapshot_path);
  return { id: expected.id, sha: expected.sha, digest: record.source_digest, index: index.record_path };
}

function selfTest() {
  const snapshot = { schema_version: 1, files: [
    { path: 'run.mjs', base64: Buffer.from('ok').toString('base64') },
    { path: 'task.json', base64: Buffer.from('{}').toString('base64') },
  ] };
  const digest = sourceDigest(snapshot);
  assert.match(digest, hex64);
  assert.throws(() => sourceDigest({ ...snapshot, files: [snapshot.files[0], snapshot.files[0]] }), /duplicate/);
  assert.throws(() => sourceDigest({ ...snapshot, files: [{ path: '../secret', base64: 'YQ==' }] }), /source path/);
  assert.notEqual(digest, sourceDigest({ ...snapshot, files: [
    { path: 'run.mjs', base64: Buffer.from('changed').toString('base64') },
    snapshot.files[1],
  ] }), 'modified Task script must change digest');
  const invalid = () => validateArchive({
    record: { schema_version: 1, trust: 'untrusted-task-observation' },
    snapshot, index: {}, run: { id: 1 },
  }, runs[0]);
  assert.throws(invalid, /Expected values to be strictly equal/);
  console.log('Task post-merge Case self-test: 5 checks passed');
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nession-acceptance-1582' },
    signal: AbortSignal.timeout(16000),
  });
  assert.equal(response.status, 200, 'authenticated public source unavailable: ' + url + ' (' + response.status + ')');
  return response.json();
}
async function storedJson(relative) {
  const json = await githubJson('https://api.github.com/repos/' + repo + '/contents/' + relative + '?ref=task-results');
  assert.equal(json.type, 'file');
  assert.equal(json.encoding, 'base64');
  return JSON.parse(Buffer.from(json.content.replace(/\s/g, ''), 'base64').toString('utf8'));
}

function assertMainExecution() {
  const sha = String(process.env.NESSION_ACCEPTANCE_TARGET_SHA || '');
  assert.match(sha, hex40, 'missing exact target SHA');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'must run on real main push');
  assert.equal(process.env.GITHUB_REF_NAME, 'main', 'must run on trusted main');
  assert.equal(process.env.GITHUB_SHA, sha, 'source push and runtime SHA disagree');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sha);
  const filepath = process.env.NESSION_ACCEPTANCE_RUNTIME_FILE;
  assert.ok(filepath && fs.existsSync(filepath), 'full-stack runtime not started');
  const runtime = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  assert.equal(runtime.target_sha, sha);
  assert.equal(runtime.profile, 'full-stack-local');
  assert.match(String(runtime.base_url), /^http:\/\/localhost:\d+$/, 'real isolated web runtime missing');
  return { sha, runtime };
}
async function verify() {
  const { sha, runtime } = assertMainExecution();
  const response = await fetch(runtime.base_url + '/', { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'exact main-SHA runtime did not serve HTTP 200');

  const [branch, otherBranch] = await Promise.all([
    githubJson('https://api.github.com/repos/' + repo + '/branches/task-results'),
    githubJson('https://api.github.com/repos/' + repo + '/branches/acceptance-results'),
  ]);
  assert.notEqual(branch.commit.sha, otherBranch.commit.sha, 'Task and Acceptance stores must be isolated');
  const observed = [];
  for (const expected of runs) {
    const key = expected.id + '-1';
    const [record, snapshot, index, run] = await Promise.all([
      storedJson('runs/1582-smoke/' + key + '/record.json'),
      storedJson('sources/' + expected.sha + '/1582-smoke.json'),
      storedJson('indexes/by-sha/' + expected.sha + '/' + key + '.json'),
      githubJson('https://api.github.com/repos/' + repo + '/actions/runs/' + expected.id),
    ]);
    observed.push(validateArchive({ record, snapshot, index, run }, expected));
  }
  assert.notEqual(observed[0].index, observed[1].index, 'independent runs require independent immutable records');
  assert.notEqual(observed[0].sha, observed[1].sha, 'records must bind independent exact source SHAs');

  // Deterministic idempotency, divergent immutable collision and identity rejection.
  const runner = execFileSync(process.execPath, ['scripts/task-runner.mjs', 'self-test'], {
    cwd: root, encoding: 'utf8', timeout: 40000,
  });
  const ingest = execFileSync(process.execPath, ['scripts/task-result-ingest.mjs', 'self-test'], {
    cwd: root, encoding: 'utf8', timeout: 40000,
  });
  assert.match(runner, /Task runner positive and negative self-tests passed/);
  assert.match(ingest, /Task result ingest positive and negative self-tests passed/);
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/task-result-ingest.yml'), 'utf8');
  assert.match(workflow, /ref:\s*main\s*\n\s*path:\s*trusted/, 'ingest must check out trusted main');
  assert.match(workflow, /checkout --orphan task-results/, 'isolated orphan store required');
  assert.match(workflow, /git -C task-store push origin HEAD:refs\/heads\/task-results/, 'must persist on dedicated branch');
  assert.doesNotMatch(workflow, /refs\/heads\/acceptance-results/, 'Task ingest must not write Acceptance store');
  assert.doesNotMatch(workflow, /issues:\s*write/, 'Task Ingest must not write Issues');

  return {
    status: 'pass',
    summary: 'Post-merge main SHA ran a real full-stack service; two real Task executions have separately authenticated, SHA-pinned immutable records, indexed source snapshots and read-only Acceptance boundary, with idempotency and collision tests.',
    evidence: [
      { type: 'runtime', value: 'main exact_sha=' + sha + ' isolated full-stack HTTP 200' },
      ...observed.map(x => ({ type: 'record', value:
        'run=' + x.id + ' exact_task_sha=' + x.sha + ' source_sha256=' + x.digest + ' durable=' + x.index })),
      { type: 'store', value: 'task-results commit=' + branch.commit.sha +
        ' != acceptance-results commit=' + otherBranch.commit.sha + '; two source snapshots and SHA indexes verified' },
      { type: 'negative-tests', value: 'task-runner + task-result-ingest self-tests: malformed identity, immutable collision, idempotent retry, unsafe path and source-boundary checks passed' },
      { type: 'security', value: 'trusted main-only ingestion; no Issue write permission and no acceptance-results ref writes' },
    ],
  };
}
if (process.argv.includes('--self-test')) selfTest();
else verify().then(value => {
  console.log(JSON.stringify(value));
}).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({
    status: 'fail', summary: message,
    evidence: [{ type: 'runtime', value: 'SC-04 source or durable ingest verification failed' }],
  }));
  process.exitCode = 1;
});
