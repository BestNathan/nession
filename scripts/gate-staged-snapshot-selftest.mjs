#!/usr/bin/env node
// #2957: real Git-index, real hook/router/runner and canonical Gate adapters;
// only cargo and npx executables are mocked for deterministic format/lint proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN_ENV = { ...process.env };
for (const key of [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX',
  'NESSION_PRE_COMMIT_STAGED', 'NESSION_INDEX_TREE',
]) delete CLEAN_ENV[key];

function execute(command, args, cwd, env = CLEAN_ENV) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined, 'unable to execute ' + command);
  return result;
}
function git(cwd, ...args) {
  const result = execute('git', args, cwd);
  assert.equal(result.status, 0,
    'git ' + args.join(' ') + ' failed:\n' + result.stdout + '\n' + result.stderr);
  return result.stdout;
}
function write(root, relative, content, executable = false) {
  const location = path.join(root, relative);
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, content, { mode: executable ? 0o755 : 0o644 });
}
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-index-hook-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const copies = [
    '.githooks/pre-commit', 'gates/route', 'gates/run',
    'gates/run-staged-index', 'gates/lib/common.sh',
    'gates/checks/dev-workspace-commit.sh',
    'gates/checks/rust-format.sh', 'gates/checks/web-eslint.sh',
    'scripts/check-dev-workspace.sh',
  ];
  for (const relative of copies) {
    const dest = path.join(repo, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), dest);
  }
  write(repo, 'gates/suites/pre-commit.gates',
    'dev-workspace-commit\nrust-format\nweb-eslint\n');
  write(repo, 'crates/demo/src/lib.rs', 'fn clean() {}\n');
  write(repo, 'web/src/Owner.tsx', 'export const clean = true;\n');
  write(repo, 'README.md', 'Gate snapshot fixture\n');

  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Git Fixture');
  git(repo, 'add', '-A');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture baseline');
  const worktree = path.join(repo, '.claude/worktrees/fix-staged-snapshot');
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/staged-snapshot', worktree);
  fs.mkdirSync(path.join(worktree, 'web/node_modules'), { recursive: true });

  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  write(bin, 'cargo', [
    '#!/usr/bin/env bash',
    'printf "cargo:%s\\n" "$*" >> "$GATE_TOOL_CAPTURE"',
    '[ "$*" = "fmt --all -- --check" ] || exit 2',
    'if [ "$GATE_MUTATE_INDEX" = 1 ]; then',
    '  git -C "$GATE_ORIGINAL_WORKTREE" add web/src/Owner.tsx || exit 2',
    'fi',
    'if [ -f crates/demo/src/lib.rs ] && grep -q BAD_FORMAT crates/demo/src/lib.rs; then exit 1; fi',
    'exit 0',
  ].join('\n') + '\n', true);
  write(bin, 'npx', [
    '#!/usr/bin/env bash',
    'printf "npx:%s\\n" "$*" >> "$GATE_TOOL_CAPTURE"',
    '[ "$1" = eslint ] || exit 2',
    'if [ -f src/Owner.tsx ] && grep -q BAD_LINT src/Owner.tsx; then exit 1; fi',
    'exit 0',
  ].join('\n') + '\n', true);
  return { temp, worktree, bin, capture: path.join(temp, 'tool-capture.log') };
}
function runHook(f, overrides = {}) {
  fs.rmSync(f.capture, { force: true });
  const env = {
    ...CLEAN_ENV,
    PATH: f.bin + path.delimiter + CLEAN_ENV.PATH,
    GATE_TOOL_CAPTURE: f.capture,
    GATE_ORIGINAL_WORKTREE: f.worktree,
    GATE_MUTATE_INDEX: '0',
    ...overrides,
  };
  const result = execute('bash', ['.githooks/pre-commit'], f.worktree, env);
  const called = fs.existsSync(f.capture) ? fs.readFileSync(f.capture, 'utf8') : '';
  return { ...result, called };
}
function assertStatus(result, expected, label) {
  assert.equal(result.status, expected,
    label + ': expected exit ' + expected + ', got ' + result.status +
    '\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
}
function unchanged(f, action) {
  const beforeIndex = git(f.worktree, 'ls-files', '--stage', '-z');
  const beforeStatus = git(f.worktree, 'status', '--porcelain', '-z');
  action();
  assert.equal(git(f.worktree, 'ls-files', '--stage', '-z'), beforeIndex,
    'hook modified Git index');
  assert.equal(git(f.worktree, 'status', '--porcelain', '-z'), beforeStatus,
    'hook modified working-tree state');
}
function withFixture(run) {
  const f = fixture();
  try { run(f); }
  finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
}

// Staged violations must fail even if the unstaged copy is repaired.
for (const [name, relative, bad, clean, tool] of [
  ['Rust', 'crates/demo/src/lib.rs', 'fn BAD_FORMAT(){}\n', 'fn clean() {}\n', 'cargo:fmt'],
  ['ESLint', 'web/src/Owner.tsx', 'export const BAD_LINT = true;\n',
    'export const clean = true;\n', 'npx:eslint'],
]) {
  withFixture((f) => {
    write(f.worktree, relative, bad);
    git(f.worktree, 'add', relative);
    write(f.worktree, relative, clean);
    assert.equal(git(f.worktree, 'show', ':' + relative), bad);
    unchanged(f, () => {
      const result = runHook(f);
      assertStatus(result, 1, name + ' invalid staged source');
      assert.ok(result.called.includes(tool), name + ' canonical Gate was not executed');
    });
    assert.equal(fs.readFileSync(path.join(f.worktree, relative), 'utf8'), clean);
  });
}

// Independently valid staged content must pass despite bad unstaged edits.
for (const [name, relative, good, bad] of [
  ['Rust', 'crates/demo/src/lib.rs', 'fn staged_clean() {}\n', 'fn BAD_FORMAT(){}\n'],
  ['ESLint', 'web/src/Owner.tsx', 'export const stagedClean = true;\n',
    'export const BAD_LINT = true;\n'],
]) {
  withFixture((f) => {
    write(f.worktree, relative, good);
    git(f.worktree, 'add', relative);
    write(f.worktree, relative, bad);
    unchanged(f, () => assertStatus(runHook(f), 0, name + ' clean staged source'));
    assert.equal(fs.readFileSync(path.join(f.worktree, relative), 'utf8'), bad);
    assert.equal(git(f.worktree, 'show', ':' + relative), good);
  });
}

// Deletions and renames continue to route original-path owners.
withFixture((f) => {
  fs.mkdirSync(path.join(f.worktree, 'docs'), { recursive: true });
  git(f.worktree, 'mv', 'web/src/Owner.tsx', 'docs/Owner.txt');
  unchanged(f, () => {
    const result = runHook(f);
    assertStatus(result, 0, 'Web rename');
    assert.ok(result.called.includes('npx:eslint'), 'rename lost Web Gate');
  });
});
withFixture((f) => {
  git(f.worktree, 'rm', 'crates/demo/src/lib.rs');
  unchanged(f, () => {
    const result = runHook(f);
    assertStatus(result, 0, 'Rust deletion');
    assert.ok(result.called.includes('cargo:fmt'), 'deletion lost Rust Gate');
  });
});

// Missing dependencies, unreadable index, or a concurrent restage => ERROR.
withFixture((f) => {
  write(f.worktree, 'web/src/Owner.tsx', 'export const updated = true;\n');
  git(f.worktree, 'add', 'web/src/Owner.tsx');
  fs.rmSync(path.join(f.worktree, 'web/node_modules'), { recursive: true, force: true });
  unchanged(f, () => assertStatus(runHook(f), 2, 'missing Web dependencies'));
});
withFixture((f) => {
  const result = runHook(f, { GIT_INDEX_FILE: f.temp }); // directory, not index
  assertStatus(result, 2, 'unreadable Git index');
  assert.equal(result.called, '', 'Gates ran after unreadable index');
});
withFixture((f) => {
  write(f.worktree, 'crates/demo/src/lib.rs', 'fn staged_clean() {}\n');
  git(f.worktree, 'add', 'crates/demo/src/lib.rs');
  write(f.worktree, 'web/src/Owner.tsx', 'export const concurrent = true;\n');
  const result = runHook(f, { GATE_MUTATE_INDEX: '1' });
  assertStatus(result, 2, 'concurrent staging');
  assert.match(result.stderr, /index changed or became unreadable/);
});
console.log('gate staged snapshot: invalid/valid partial staging, rename, delete, missing tooling and index error fixtures passed');
