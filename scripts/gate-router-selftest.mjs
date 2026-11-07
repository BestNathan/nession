import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Git exports GIT_DIR/GIT_WORK_TREE to pre-push hooks. This test creates and
// commits in throwaway repositories; ambient hook variables would redirect
// those Git commands into the caller's real checkout.
for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR']) delete process.env[key];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitStub = [
  '#!/usr/bin/env bash',
  'if [ "$1" = "diff" ]; then',
  '  if [ "$MOCK_DIFF_ERROR" = "1" ]; then exit 128; fi',
  '  printf "%s\\n" "$MOCK_CHANGED"',
  '  exit 0',
  'fi',
  'exit 0',
  '',
].join('\n');
const runnerStub = [
  '#!/usr/bin/env bash',
  'printf "%s\\n" "$@" >> "$GATE_ROUTER_CAPTURE"',
  '',
].join('\n');

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-gate-router-'));
  for (const sub of ['.githooks', 'gates/suites', 'bin', 'scripts/lib']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const hook of ['pre-commit', 'pre-push']) {
    fs.copyFileSync(path.join(root, '.githooks', hook), path.join(dir, '.githooks', hook));
    fs.copyFileSync(path.join(root, 'gates/suites', hook + '.gates'),
      path.join(dir, 'gates/suites', hook + '.gates'));
  }
  fs.copyFileSync(path.join(root, 'gates/route'), path.join(dir, 'gates/route'));
  fs.copyFileSync(path.join(root, 'scripts/lib/git-diff-base.sh'),
    path.join(dir, 'scripts/lib/git-diff-base.sh'));
  fs.writeFileSync(path.join(dir, 'bin/git'), gitStub, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'gates/run'), runnerStub, { mode: 0o755 });
  return dir;
}

function execute(dir, hook, changed, diffError = false) {
  const capture = path.join(dir, 'gates-capture.txt');
  fs.rmSync(capture, { force: true });
  const env = {
    ...process.env,
    PATH: path.join(dir, 'bin') + path.delimiter + (process.env.PATH ?? ''),
    MOCK_CHANGED: changed,
    MOCK_DIFF_ERROR: diffError ? '1' : '0',
    GATE_ROUTER_CAPTURE: capture,
  };
  const input = hook === 'pre-push'
    ? 'refs/heads/test ' + '1'.repeat(40) + ' refs/heads/test ' + '2'.repeat(40) + '\n'
    : '';
  const result = spawnSync('bash', [path.join(dir, '.githooks', hook)], {
    cwd: dir, env, input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, 'failed to spawn hook');
  const ids = fs.existsSync(capture)
    ? fs.readFileSync(capture, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  return { ...result, ids };
}

function requireIds(ids, expected, label) {
  for (const id of expected) {
    assert.ok(ids.includes(id), label + ': missing Gate ' + id + '; selected: ' + ids.join(','));
  }
}
function rejectIds(ids, forbidden, label) {
  for (const id of forbidden) {
    assert.ok(!ids.includes(id), label + ': unexpectedly selected ' + id);
  }
}

const cases = [
  { hook: 'pre-commit', changed: 'README.md', expected: ['dev-workspace-commit'] },
  { hook: 'pre-commit', changed: 'docs/AGENTS.md', expected: ['instruction-contract'] },
  { hook: 'pre-commit', changed: 'crates/nession-agent/src/lib.rs',
    expected: ['rust-format', 'test-isolation', 'tmux-socket-isolation', 'protocol-integrity'],
    absent: ['rust-clippy', 'rust-test-unit', 'rust-coverage', 'rust-test-integration'] },
  { hook: 'pre-commit', changed: 'web/src/App.tsx',
    expected: ['web-eslint', 'design-system-fast'],
    absent: ['web-typecheck', 'web-test-unit', 'web-coverage', 'web-test-integration'] },
  { hook: 'pre-commit', changed: 'scripts/protocol-gate.mjs',
    expected: ['protocol-integrity'],
    absent: ['protocol-integrity-selftest'] },
  { hook: 'pre-commit', changed: '.githooks/pre-commit',
    expected: ['instruction-contract'],
    absent: ['gate-router-contract', 'gate-runtime-contract'] },
  { hook: 'pre-push', changed: 'README.md', expected: ['dev-workspace-push'] },
  { hook: 'pre-push', changed: 'crates/nession-agent/src/lib.rs',
    expected: ['rust-clippy', 'rust-test-unit'],
    absent: ['rust-test-integration', 'rust-coverage'] },
  { hook: 'pre-push', changed: 'web/src/App.tsx',
    expected: ['web-typecheck', 'web-test-unit'],
    absent: ['web-test-integration', 'web-coverage', 'design-system-full'] },
  { hook: 'pre-push', changed: 'scripts/protocol-gate.mjs',
    expected: ['protocol-integrity', 'protocol-codegen-drift', 'protocol-integrity-selftest'] },
  { hook: 'pre-push', changed: 'gates/checks/tmux-socket-isolation.sh',
    expected: ['gate-runtime-contract', 'gate-router-contract', 'tmux-socket-isolation-selftest'] },
  { hook: 'pre-push', changed: 'scripts/check-test-isolation.sh',
    expected: ['test-isolation-selftest'] },
  { hook: 'pre-push', changed: 'scripts/server-handler-concurrency-selftest.mjs',
    expected: ['server-handler-locality', 'server-handler-locality-selftest', 'server-handler-concurrency-selftest'] },
  { hook: 'pre-push', changed: 'scripts/check-dev-workspace.sh',
    expected: ['dev-workspace-selftest'] },
  { hook: 'pre-push', changed: 'scripts/filtered-test.sh',
    expected: ['rust-test-unit'], absent: ['rust-clippy', 'web-test-unit'] },
  { hook: 'pre-push', changed: 'scripts/filtered-web-test.sh',
    expected: ['web-test-unit'], absent: ['rust-test-unit', 'web-typecheck'] },
  { hook: 'pre-push', changed: 'gates/route',
    expected: ['gate-runtime-contract', 'gate-router-contract', 'pre-push-diff-base-selftest'] },
  { hook: 'pre-push', changed: 'scripts/protocol-gate.mjs', diffError: true,
    expected: ['rust-test-unit', 'web-test-unit', 'gate-runtime-contract', 'protocol-integrity-selftest'],
    absent: ['rust-coverage', 'web-coverage'] },
];

for (const [index, c] of cases.entries()) {
  const dir = createFixture();
  try {
    const result = execute(dir, c.hook, c.changed, c.diffError ?? false);
    assert.equal(result.status, 0, 'case ' + index + ' returned nonzero:\n' + result.stdout + '\n' + result.stderr);
    requireIds(result.ids, c.expected, 'case ' + index);
    rejectIds(result.ids, c.absent ?? [], 'case ' + index);
    assert.ok(result.ids.includes(c.hook === 'pre-commit' ? 'dev-workspace-commit' : 'dev-workspace-push'));
    if (c.changed === 'README.md') {
      assert.deepEqual(result.ids, [c.hook === 'pre-commit' ? 'dev-workspace-commit' : 'dev-workspace-push']);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Missing Git metadata at commit must error; at push it must broaden scope.
{
  const dir = createFixture();
  try {
    assert.equal(execute(dir, 'pre-commit', 'web/src/App.tsx', true).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// An unrecognized Gate must not be silently omitted from an active hook suite.
{
  const dir = createFixture();
  try {
    fs.appendFileSync(path.join(dir, 'gates/suites/pre-push.gates'), 'unknown-gate\n');
    assert.equal(execute(dir, 'pre-push', 'README.md').status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Mutation fixtures: removing a required owner selftest from the canonical
// stage suite must break the corresponding positive routing assertion.
for (const [hook, changed, id] of [
  ['pre-push', 'scripts/protocol-gate.mjs', 'protocol-integrity-selftest'],
  ['pre-push', 'gates/route', 'gate-router-contract'],
]) {
  const dir = createFixture();
  try {
    const suite = path.join(dir, 'gates/suites', hook + '.gates');
    const original = fs.readFileSync(suite, 'utf8');
    assert.ok(original.includes('\n' + id + '\n'), 'mutation target absent: ' + id);
    fs.writeFileSync(suite, original.replace('\n' + id + '\n', '\n'));
    const result = execute(dir, hook, changed);
    assert.equal(result.status, 0);
    assert.throws(() => requireIds(result.ids, [id], hook + ' mutation'),
      new RegExp('missing Gate ' + id));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log('gate-router-selftest: ' + cases.length + ' positive, 2 fail-closed, 2 mutation fixtures passed');

// Prove the real Git rename boundary, not just mocked path strings. With
// rename detection enabled Git's --name-only reports only the destination;
// the Gate router must inspect BOTH old and new paths for deleted owners.
function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, 'unable to run git ' + args.join(' '));
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ' failed:\n' +
    result.stdout + '\n' + result.stderr);
  return result.stdout.trim();
}

function executeRealHook(dir, hook, baseSha) {
  const capture = path.join(dir, 'gates-capture.txt');
  fs.rmSync(capture, { force: true });
  const localSha = git(dir, 'rev-parse', 'HEAD');
  const input = hook === 'pre-push'
    ? 'refs/heads/main ' + localSha + ' refs/heads/main ' + baseSha + '\n'
    : '';
  const result = spawnSync('bash', [path.join(dir, '.githooks', hook)], {
    cwd: dir,
    env: { ...process.env, GATE_ROUTER_CAPTURE: capture },
    input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, 'cannot execute real Git fixture');
  const ids = fs.existsSync(capture)
    ? fs.readFileSync(capture, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  return { ...result, ids };
}

const renameCases = [
  { from: 'docs/AGENTS.md', to: 'docs/instructions.txt',
    commit: ['instruction-contract'], push: ['instruction-contract'] },
  { from: 'crates/nession-agent/src/owner.rs', to: 'docs/owner.txt',
    commit: ['rust-format', 'test-isolation'], push: ['rust-clippy', 'rust-test-unit'] },
  { from: 'web/src/Owner.tsx', to: 'docs/Owner.txt',
    commit: ['web-eslint', 'design-system-fast'], push: ['web-typecheck', 'web-test-unit'] },
  { from: 'scripts/filtered-test.sh', to: 'docs/rust-runner.txt',
    commit: [], push: ['rust-test-unit'] },
  { from: 'scripts/filtered-web-test.sh', to: 'docs/web-runner.txt',
    commit: [], push: ['web-test-unit'] },
];

function verifyRenameCase(c, mutate = false) {
  const dir = createFixture();
  try {
    // Use the real system git, not the PATH stub used by the other scenarios.
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'Gate fixture');
    git(dir, 'config', 'user.email', 'gate-fixture@example.invalid');
    git(dir, 'config', 'diff.renames', 'true');
    fs.mkdirSync(path.dirname(path.join(dir, c.from)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(dir, c.to)), { recursive: true });
    fs.writeFileSync(path.join(dir, c.from), 'stable file content\n');
    git(dir, 'add', c.from);
    git(dir, 'commit', '-qm', 'before rename');
    const baseSha = git(dir, 'rev-parse', 'HEAD');

    if (mutate) {
      const router = path.join(dir, 'gates/route');
      const original = fs.readFileSync(router, 'utf8');
      assert.equal((original.match(/ --no-renames/g) ?? []).length, 2);
      fs.writeFileSync(router, original.replaceAll(' --no-renames', ''));
    }

    git(dir, 'mv', c.from, c.to);
    const naiveCommitPaths = git(dir, 'diff', '--cached', '--name-only').split('\n');
    assert.ok(!naiveCommitPaths.includes(c.from), 'fixture must expose rename-source loss');
    assert.ok(naiveCommitPaths.includes(c.to));

    const commit = executeRealHook(dir, 'pre-commit', baseSha);
    assert.equal(commit.status, 0, 'real rename commit hook failed:\n' + commit.stderr);
    if (mutate) {
      for (const id of c.commit) assert.ok(!commit.ids.includes(id), 'mutation still selected ' + id);
    } else {
      requireIds(commit.ids, c.commit, 'real Git staged rename ' + c.from);
    }

    git(dir, 'commit', '-qm', 'rename owner');
    const naivePushPaths = git(dir, 'diff', '--name-only', baseSha, 'HEAD').split('\n');
    assert.ok(!naivePushPaths.includes(c.from), 'fixture must expose push rename-source loss');
    const push = executeRealHook(dir, 'pre-push', baseSha);
    assert.equal(push.status, 0, 'real rename push hook failed:\n' + push.stderr);
    if (mutate) {
      for (const id of c.push) assert.ok(!push.ids.includes(id), 'mutation still selected ' + id);
    } else {
      requireIds(push.ids, c.push, 'real Git pushed rename ' + c.from);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of renameCases) verifyRenameCase(c);
// Mutation proves the real Git fixture fails to select instruction owners
// if --no-renames is removed from both pre-commit and pre-push routing.
verifyRenameCase(renameCases[0], true);
console.log('real-git rename fixtures: ' + renameCases.length + ' positive, 1 mutation passed');

