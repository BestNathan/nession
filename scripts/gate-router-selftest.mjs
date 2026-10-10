import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  for (const sub of ['.githooks', 'gates', 'bin', 'scripts/lib']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const hook of ['pre-commit', 'pre-push']) {
    fs.copyFileSync(path.join(root, '.githooks', hook), path.join(dir, '.githooks', hook));
  }
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
  // Existing remote ref exercises diff-scoped routing, not reflog bootstrap.
  const input = hook === 'pre-push'
    ? 'refs/heads/test ' + '1'.repeat(40) + ' refs/heads/test ' + '2'.repeat(40) + '\n'
    : '';
  const result = spawnSync('bash', [path.join(dir, '.githooks', hook)], {
    cwd: dir, env, input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, 'failed to spawn hook');
  assert.equal(result.status, 0, hook + ' returned nonzero:\n' + result.stdout + '\n' + result.stderr);
  return fs.existsSync(capture)
    ? fs.readFileSync(capture, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
}
function requireIds(ids, expected, label) {
  for (const id of expected) {
    assert.ok(ids.includes(id), label + ': missing Gate ' + id + '; selected: ' + ids.join(','));
  }
}
const cases = [
  { hook: 'pre-commit', changed: 'README.md', expected: ['dev-workspace-commit'] },
  { hook: 'pre-commit', changed: 'docs/AGENTS.md', expected: ['instruction-contract'] },
  { hook: 'pre-commit', changed: 'crates/nession-agent/src/lib.rs',
    expected: ['rust-format', 'rust-clippy', 'rust-test-unit', 'test-isolation', 'tmux-socket-isolation', 'protocol-integrity'] },
  { hook: 'pre-commit', changed: 'scripts/protocol-gate.mjs',
    expected: ['protocol-integrity', 'protocol-integrity-selftest'] },
  { hook: 'pre-commit', changed: 'gates/checks/protocol-integrity.sh',
    expected: ['gate-runtime-contract', 'gate-router-contract', 'protocol-integrity', 'protocol-integrity-selftest'] },
  { hook: 'pre-commit', changed: '.githooks/pre-commit',
    expected: ['instruction-contract', 'gate-runtime-contract', 'gate-router-contract'] },
  { hook: 'pre-commit', changed: 'scripts/gate-router-selftest.mjs',
    expected: ['gate-runtime-contract', 'gate-router-contract'] },
  { hook: 'pre-push', changed: 'README.md', expected: ['dev-workspace-push'] },
  { hook: 'pre-push', changed: 'web/src/main.tsx',
    expected: ['web-test-unit', 'web-test-integration', 'web-coverage', 'design-system-full'] },
  { hook: 'pre-push', changed: 'scripts/protocol-gate.mjs',
    expected: ['protocol-integrity', 'protocol-codegen-drift', 'protocol-integrity-selftest'] },
  { hook: 'pre-push', changed: 'gates/checks/tmux-socket-isolation.sh',
    expected: ['gate-runtime-contract', 'gate-router-contract', 'tmux-socket-isolation', 'tmux-socket-isolation-selftest'] },
  { hook: 'pre-push', changed: 'scripts/gate-router-selftest.mjs',
    expected: ['gate-runtime-contract', 'gate-router-contract'] },
  { hook: 'pre-push', changed: 'scripts/check-test-isolation.sh',
    expected: ['test-isolation', 'test-isolation-selftest'] },
  { hook: 'pre-push', changed: 'scripts/protocol-gate.mjs', diffError: true,
    expected: ['gate-runtime-contract', 'gate-router-contract', 'rust-coverage', 'web-coverage', 'protocol-integrity-selftest'] },
];
for (const [index, c] of cases.entries()) {
  const dir = createFixture();
  try {
    const ids = execute(dir, c.hook, c.changed, c.diffError ?? false);
    requireIds(ids, c.expected, 'case ' + index);
    assert.ok(ids.includes(c.hook === 'pre-commit' ? 'dev-workspace-commit' : 'dev-workspace-push'));
    if (c.changed === 'README.md') {
      assert.ok(!ids.includes('gate-router-contract'), 'unrelated Markdown caused full Gate run');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Mutation fixture: intentionally remove the detection's self-test route and
// prove the same assertion detects that regression (not a trivially green test).
for (const hook of ['pre-commit', 'pre-push']) {
  const dir = createFixture();
  try {
    const file = path.join(dir, '.githooks', hook);
    const original = fs.readFileSync(file, 'utf8');
    const mutation = '  GATE_IDS+=(protocol-integrity-selftest)';
    assert.ok(original.includes(mutation), 'mutation target absent: ' + hook);
    fs.writeFileSync(file, original.replace(mutation,
      '  : # negative fixture: protocol self-test route removed'));
    const selected = execute(dir, hook, 'scripts/protocol-gate.mjs');
    assert.throws(() => requireIds(selected, ['protocol-integrity-selftest'], hook + ' mutation'),
      /missing Gate protocol-integrity-selftest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log('gate-router-selftest: ' + cases.length + ' positive and 2 negative fixtures passed');
