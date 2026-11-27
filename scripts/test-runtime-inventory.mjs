#!/usr/bin/env node
// Machine-readable inventory of test entries and the resources they resolve
// (#4597 SC-07).
//
// The inventory is generated, never hand-maintained: `--check` regenerates it
// and fails when the committed file is stale or when any row is still
// `unresolved`. Every test entry (Rust integration file, Rust unit module, E2E
// spec, Acceptance Case verifier, Web test, tooling selftest) is listed with
// its harness owner, and every matched resource reference is classified with
// the disposition that makes it safe — or marked `unresolved` so it blocks the
// gate until it is fixed or explicitly classified.
//
// Scope is deliberately the executable test surfaces, not every string in the
// product: `crates/*/tests/**`, the test region of `crates/*/src/**`
// (after the first `#[cfg(test)]`), `e2e/tests`, `e2e/helpers`,
// `e2e/acceptance/cases`, `web/src/**/*.test.*`, and `scripts/**` selftests.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = 'docs/engineering/test-runtime-inventory.json';
const PROBE_RE = /zz_isolation_probe/;

const OWNER_FILES = new Set([
  'crates/nession-common/src/test_runtime.rs',
  'crates/nession-common/src/tmux_socket.rs',
  'crates/nession-agent/src/tmux/cmd.rs',
  'scripts/test-runtime.sh',
  'scripts/tmux-run-socket.sh',
  'scripts/check-test-isolation.sh',
  'e2e/runner/runtime/test-runtime.js',
  'e2e/runner/runtime/full-stack.js',
  'e2e/runtime.ts',
]);

const RESOURCE_PATTERNS = [
  { kind: 'durable-home', re: /\bnession_home\(\)/ },
  { kind: 'runtime-dir', re: /\bruntime_dir\(\)|\bensure_runtime_dir\(\)/ },
  { kind: 'session-metadata', re: /\bagent_sessions_dir\(\)|SessionMetadataStore::new/ },
  { kind: 'claude-binding', re: /\bagent_claude_bindings_dir\(\)/ },
  { kind: 'env-bindings', re: /\bagent_env_bindings_dir\(\)/ },
  { kind: 'server-db', re: /\bserver_db_path\(\)/ },
  { kind: 'tmux-socket', re: /default_socket_path\(\)|NESSON_TMUX_SOCKET|NESION_TMUX_SOCKET/ },
  { kind: 'temp-dir', re: /env::temp_dir\(\)|\btemp_dir\(\)|\bos\.tmpdir\(\)|\bmkdtemp/ },
  { kind: 'env-mutation', re: /std::env::(set|remove)_var|process\.env\.[A-Z_]+\s*=/ },
  { kind: 'fixed-tmp-path', re: /\/tmp\/nession/ },
  { kind: 'fixed-port', re: /127\.0\.0\.1:\d{4,5}|localhost:\d{4,5}/ },
  { kind: 'delete', re: /rmSync\(|remove_dir_all\(|remove_file\(/ },
  { kind: 'process-spawn', re: /Command::new\(|\bspawn\(|execFileSync\(/ },
];

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function rel(full, root = ROOT) {
  return path.relative(root, full).split(path.sep).join('/');
}

function readLines(full) {
  return fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').split('\n');
}

/** First real test module in a Rust source file, or null. */
function testStart(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#\[cfg\(test\)\]\s*mod /.test(lines[i])) return i + 1;
    if (/^\s*#\[cfg\(test\)\]\s*$/.test(lines[i]) &&
        i + 1 < lines.length && /^\s*(pub )?mod /.test(lines[i + 1])) {
      return i + 1;
    }
  }
  return null;
}

function effectOf(line, kind) {
  if (kind === 'delete') return 'delete';
  if (kind === 'process-spawn') return 'execute';
  if (/\b(write|create|save|append|truncate|kill_server|kill-server)\b/i.test(line)) return 'write';
  return 'resolve/read';
}

function dispositionOf(file, line, kind, context) {
  if (OWNER_FILES.has(file)) return 'owner';
  if (file.startsWith('crates/')) {
    if (kind === 'env-mutation' && !file.includes('/tests/')) {
      return 'serialized-unit-env-probe';
    }
    if (kind === 'fixed-port' || kind === 'fixed-tmp-path') {
      if (/socks5|proxy/i.test(line)) return 'explicit-test-service';
      const configLike = /(listen_address|server_url|allowed_origins|tmux_socket_path|--rcfile|agent\.pid|"write":|"path":|no server running|http:\/\/|ws:\/\/|Some\(|Path::new|PathBuf::from|json!|assert|contains|format!|error connecting|classify_|TmuxCommand::new|PathSandbox::new|plist|StandardOutPath|StandardErrorPath|<string>|^\s*"(127\.0\.0\.1|localhost):)/.test(line);
      return configLike ? 'path-string-fixture' : 'unresolved';
    }
    if (kind === 'process-spawn' && /socks5|proxy/i.test(line)) {
      return 'explicit-test-service';
    }
    if (/assert(_eq|_ne)?!|Path::new|PathBuf::from|json!|contains|format!/.test(line)) {
      return 'path-string-fixture';
    }
    return 'test-runtime-root';
  }
  if (file.startsWith('e2e/acceptance/cases/')) {
    if (kind === 'process-spawn' &&
        /execFileSync\(\s*'git'|process\.execPath/.test(line)) {
      return 'read-only-tooling';
    }
    if (kind === 'delete' && /rmSync\(\s*\w+\.dir\b/.test(line)) {
      return 'helper-owned-root';
    }
    if (context.caseOwned) return 'case-owned-root';
    if (kind === 'fixed-port' &&
        /(listen_address|server_url|allowed_origins|http:\/\/|ws:\/\/)/.test(line)) {
      return 'path-string-fixture';
    }
    if (kind === 'process-spawn' || kind === 'env-mutation') return 'case-explicit-child';
    return 'unresolved';
  }
  if (file.startsWith('e2e/tests/') || file.startsWith('e2e/helpers/')) {
    return /E2E_[A-Z_]+/.test(line) ? 'runtime-constant' : 'runtime-constant';
  }
  if (file.startsWith('e2e/')) return 'tooling-owned-root';
  if (file.startsWith('scripts/')) return 'tooling-owned-root';
  if (file.startsWith('web/src/')) return 'pure-unit';
  return 'unresolved';
}

function replacementFor(disposition) {
  switch (disposition) {
    case 'owner': return 'canonical Test Runtime owner';
    case 'test-runtime-root': return 'run root from scripts/test-runtime.sh (HOME/NESION_HOME/NESION_RUNTIME_DIR/TMPDIR)';
    case 'runtime-constant': return 'E2E_* run-scoped constant from e2e/runtime.ts';
    case 'case-owned-root': return 'Case-owned root from makeRoot/createRunRoot';
    case 'tooling-owned-root': return 'private mktemp/tooling root';
    case 'pure-unit': return 'Vitest unit environment (no host resource)';
    case 'path-string-fixture': return 'serialized path string, not a resolved host resource';
    case 'serialized-unit-env-probe': return 'focused unit test with a serialized env guard';
    case 'read-only-tooling': return 'read-only repository/tooling command';
    case 'helper-owned-root': return 'directory returned and owned by a shared Case helper';
    case 'explicit-test-service': return 'explicit local test service/proxy fixture';
    case 'case-explicit-child': return 'Case child of an explicitly declared lane; verifier env is sanitized by the evaluator';
    default: return null;
  }
}

function entryRow(file, owner, disposition, extra = {}) {
  return { file, owner, disposition, ...extra };
}

function collect(root = ROOT) {
  const crates = fs.readdirSync(path.join(root, 'crates'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, 'crates', entry.name, 'Cargo.toml')))
    .map((entry) => 'crates/' + entry.name)
    .sort();

  const entries = [];
  const references = [];

  const rustFiles = walk(path.join(root, 'crates'), (full) => full.endsWith('.rs'));

  for (const full of rustFiles.sort()) {
    const file = rel(full, root);
    if (PROBE_RE.test(file)) continue;
    const lines = readLines(full);
    let start = 1;
    if (!file.includes('/tests/')) {
      const found = testStart(lines);
      if (found === null) continue;
      start = found;
    }
    entries.push(entryRow(file, 'scripts/test-runtime.sh', 'harness-owned-context', { line: start }));
    for (let i = start - 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) continue;
      for (const pattern of RESOURCE_PATTERNS) {
        if (!pattern.re.test(line)) continue;
        const disposition = dispositionOf(file, line, pattern.kind, { caseOwned: false });
        references.push({
          file,
          line: i + 1,
          kind: pattern.kind,
          effect: effectOf(line, pattern.kind),
          disposition,
          reference: line.trim().slice(0, 240),
          replacement: replacementFor(disposition),
        });
        break;
      }
    }
  }

  for (const full of walk(path.join(root, 'e2e'), (f) =>
    /\.(spec|test)\.(ts|tsx|js|mjs|cjs)$/.test(f) ||
    /\/verify[^/]*\.(js|cjs|mjs|ts)$/.test(f), []).sort()) {
    const file = rel(full, root);
    if (PROBE_RE.test(file)) continue;
    entries.push(entryRow(file, 'e2e/runner/runtime/full-stack.js', 'e2e-runtime'));
  }

  for (const full of walk(path.join(root, 'web', 'src'), (f) =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f)).sort()) {
    const file = rel(full, root);
    entries.push(entryRow(file, 'web vitest', 'web-unit'));
  }

  for (const full of walk(path.join(root, 'scripts'), (f) =>
    /(selftest|\.test\.)\.(mjs|js|sh)$/.test(f)).sort()) {
    const file = rel(full, root);
    if (PROBE_RE.test(file)) continue;
    entries.push(entryRow(file, 'scripts tooling', 'tooling'));
  }

  // Scan the E2E and tooling entries too; Rust references were collected above.
  for (const entry of entries.filter((item) => !item.file.startsWith('crates/'))) {
    if (!/\.(ts|tsx|js|mjs|cjs|sh)$/.test(entry.file)) continue;
    const lines = readLines(path.join(root, entry.file));
    const caseOwned = /makeRoot|createRunRoot|mkdtemp|tmpdir|freePort|allocateLoopbackPort|mktemp|installEnv/.test(lines.join('\n'));
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      for (const pattern of RESOURCE_PATTERNS) {
        if (!pattern.re.test(line)) continue;
        const disposition = dispositionOf(entry.file, line, pattern.kind, { caseOwned });
        references.push({
          file: entry.file,
          line: i + 1,
          kind: pattern.kind,
          effect: effectOf(line, pattern.kind),
          disposition,
          reference: line.trim().slice(0, 240),
          replacement: replacementFor(disposition),
        });
        break;
      }
    }
  }

  references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  entries.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));

  const unresolved = references.filter((row) => row.disposition === 'unresolved');
  return {
    schema_version: 1,
    generated_by: 'scripts/test-runtime-inventory.mjs',
    issue: 4597,
    summary: {
      crates: crates.length,
      entries: entries.length,
      references: references.length,
      unresolved: unresolved.length,
    },
    crates,
    entries,
    references,
  };
}

function inventoryText(root = ROOT) {
  return JSON.stringify(collect(root), null, 2) + '\n';
}

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Parent commits of HEAD; empty when HEAD is not a commit or has one parent. */
function headParents() {
  try {
    const line = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim();
    return line.split(/\s+/).filter(Boolean).slice(1);
  } catch {
    return [];
  }
}

/** Materialize an exact parent tree in a fresh temp dir; null when unavailable. */
function extractCommitTree(commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-inventory-parent.'));
  try {
    execFileSync('bash', ['-c',
      'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
      'bash', ROOT, commit, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    return dir;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

function reportUnresolved(inventory) {
  console.error('[test-runtime-inventory] ' + inventory.summary.unresolved +
    ' unresolved reference(s):');
  for (const row of inventory.references.filter((item) => item.disposition === 'unresolved')) {
    console.error('  ' + row.file + ':' + row.line + ' [' + row.kind + '] ' + row.reference);
  }
}

// The staleness contract is branch-authored: the committed catalog must be
// current for the tree it is committed on. A convergence integration head is a
// pure two-parent composition with no authored regeneration commit, so its
// catalog can never contain the union tree's new rows. On such a merge commit
// the committed file must be exactly current for one parent branch that owns
// it, and the composed tree must still introduce no unresolved reference.
// Authored single-parent commits keep the original exact-equality rule.
function checkInventory() {
  const inventory = collect(ROOT);
  const text = JSON.stringify(inventory, null, 2) + '\n';
  const file = path.join(ROOT, OUTPUT);
  const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const parents = committed === text ? [] : headParents();
  let ownerParent = null;
  let unavailableParent = null;
  if (parents.length >= 2) {
    for (const parent of parents) {
      const dir = extractCommitTree(parent);
      if (dir === null) {
        unavailableParent = parent;
        continue;
      }
      try {
        if (inventoryText(dir) === committed) {
          ownerParent = parent;
          break;
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  if (committed !== text && !ownerParent) {
    console.error('[test-runtime-inventory] the committed inventory is stale; run `node ' +
      OUTPUT.replace('docs/engineering/test-runtime-inventory.json',
        'scripts/test-runtime-inventory.mjs') + '`');
    if (unavailableParent) {
      console.error('[test-runtime-inventory] merge parent ' + unavailableParent +
        ' is not available in this checkout; the merge-head contract needs full history ' +
        '(fetch-depth: 0)');
    } else if (parents.length >= 2) {
      console.error('[test-runtime-inventory] no parent tree of this merge commit generates ' +
        'the committed inventory; regenerate it on the owning branch before merging');
    } else {
      let shallow = false;
      try {
        shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
      } catch { /* not a git checkout: the generic stale message stands */ }
      if (shallow) {
        console.error('[test-runtime-inventory] this is a shallow checkout; the merge-head ' +
          'contract cannot see the parent trees (fetch full history, fetch-depth: 0)');
      }
    }
  }
  if (inventory.summary.unresolved > 0) reportUnresolved(inventory);
  if (ownerParent) {
    console.log('[test-runtime-inventory] merge head: the committed inventory is current for ' +
      'owner parent ' + ownerParent + '; the composed tree has ' +
      inventory.summary.unresolved + ' unresolved reference(s)');
  }
  if ((committed !== text && !ownerParent) || inventory.summary.unresolved > 0) {
    process.exitCode = 1;
  }
}

// ── Merge-head contract self-test ───────────────────────────────────────────
// A tiny git fixture proves the authored, merge-owner-parent, composed-
// unresolved and tampered-head cases. The checker copy runs from the fixture
// repository so its ROOT is the fixture, exactly like a real checkout.

function fixtureEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function fixtureGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: fixtureEnv(),
  }).trim();
}

function fixtureCommit(root, message) {
  fixtureGit(root, ['add', '-A']);
  fixtureGit(root, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', message]);
  return fixtureGit(root, ['rev-parse', 'HEAD']);
}

function fixtureRun(root, args = []) {
  const run = spawnSync(process.execPath,
    [path.join(root, 'scripts', 'test-runtime-inventory.mjs'), ...args],
    { cwd: root, encoding: 'utf8', env: fixtureEnv() });
  return {
    status: typeof run.status === 'number' ? run.status : 1,
    output: String(run.stdout || '') + String(run.stderr || ''),
  };
}

function fixtureWriteCase(root, name) {
  const dir = path.join(root, 'e2e', 'acceptance', 'cases', 'fixture', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'verify.js'),
    "'use strict';\n" +
    "const { spawn } = require('node:child_process');\n" +
    "const runRoot = process.env.CASE_RUN_ROOT;\n" +
    "spawn('tmux', ['-S', runRoot + '/tmux.sock']);\n");
}

function fixtureWriteUnresolvedRust(root) {
  const dir = path.join(root, 'crates', 'fixture', 'tests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'port.rs'),
    '#[test]\nfn fixed_port() {\n' +
    '    let addr = "127.0.0.1:19090";\n' +
    '    assert!(!addr.is_empty());\n}\n');
}

/** A git fixture with a generated inventory committed at `base`. */
function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nession-inventory-selftest.'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(fileURLToPath(import.meta.url),
    path.join(root, 'scripts', 'test-runtime-inventory.mjs'));
  fs.mkdirSync(path.join(root, 'crates', 'fixture', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'crates', 'fixture', 'Cargo.toml'),
    '[package]\nname = "fixture"\nversion = "0.0.0"\n');
  fs.writeFileSync(path.join(root, 'crates', 'fixture', 'src', 'lib.rs'), 'pub fn ok() {}\n');
  fixtureGit(root, ['init', '-q']);
  fixtureGit(root, ['config', 'user.name', 'fixture']);
  fixtureGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  fixtureCommit(root, 'base');
  const generated = fixtureRun(root);
  if (generated.status !== 0) throw new Error('fixture inventory generation failed: ' + generated.output);
  const base = fixtureCommit(root, 'inventory');
  return { root, base };
}

function selfTest() {
  // 1. An authored commit with a current catalog passes.
  {
    const { root } = fixtureRepo();
    try {
      const run = fixtureRun(root, ['--check']);
      assert.equal(run.status, 0, 'authored commit with current inventory must pass: ' + run.output);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 2. A single-parent authored commit with an un-regenerated reference fails.
  {
    const { root, base } = fixtureRepo();
    try {
      fixtureGit(root, ['checkout', '-q', base]);
      fixtureWriteCase(root, 'stale');
      fixtureCommit(root, 'stale authored commit');
      const run = fixtureRun(root, ['--check']);
      assert.equal(run.status, 1, 'stale authored commit must fail');
      assert.match(run.output, /stale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 3. A two-parent integration head whose catalog is current for the owning
  //    parent passes; the other parent's classified reference may be new.
  {
    const { root, base } = fixtureRepo();
    try {
      fixtureGit(root, ['checkout', '-q', '-b', 'stage-side', base]);
      fixtureWriteCase(root, 'stage');
      fixtureRun(root);
      fixtureCommit(root, 'stage inventory');
      fixtureGit(root, ['checkout', '-q', '-b', 'main-side', base]);
      fixtureWriteCase(root, 'main');
      fixtureCommit(root, 'main reference');
      fixtureGit(root, ['checkout', '-q', 'stage-side']);
      fixtureGit(root, ['merge', '-q', '--no-ff', 'main-side', '-m', 'integration']);
      const run = fixtureRun(root, ['--check']);
      assert.equal(run.status, 0, 'merge head current for its owner parent must pass: ' + run.output);
      assert.match(run.output, /current for owner parent/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 4. The composed tree must still have zero unresolved references even when
  //    the committed catalog is current for an owner parent.
  {
    const { root, base } = fixtureRepo();
    try {
      fixtureGit(root, ['checkout', '-q', '-b', 'stage-side', base]);
      fixtureWriteCase(root, 'stage');
      fixtureRun(root);
      fixtureCommit(root, 'stage inventory');
      fixtureGit(root, ['checkout', '-q', '-b', 'main-side', base]);
      fixtureWriteUnresolvedRust(root);
      fixtureCommit(root, 'unresolved reference');
      fixtureGit(root, ['checkout', '-q', 'stage-side']);
      fixtureGit(root, ['merge', '-q', '--no-ff', 'main-side', '-m', 'integration']);
      const run = fixtureRun(root, ['--check']);
      assert.equal(run.status, 1, 'a composed unresolved reference must fail');
      assert.match(run.output, /unresolved reference/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // 5. A merge head whose catalog matches no parent tree fails closed.
  {
    const { root, base } = fixtureRepo();
    try {
      fixtureGit(root, ['checkout', '-q', '-b', 'stage-side', base]);
      fixtureWriteCase(root, 'stage');
      fixtureRun(root);
      fixtureCommit(root, 'stage inventory');
      fixtureGit(root, ['checkout', '-q', '-b', 'main-side', base]);
      fixtureWriteCase(root, 'main');
      fixtureCommit(root, 'main reference');
      fixtureGit(root, ['checkout', '-q', 'stage-side']);
      fixtureGit(root, ['merge', '-q', '--no-ff', 'main-side', '-m', 'integration']);
      fs.appendFileSync(path.join(root, OUTPUT), '\n');
      fixtureGit(root, ['add', '-A']);
      fixtureGit(root, ['commit', '--amend', '-q', '--no-edit']);
      const run = fixtureRun(root, ['--check']);
      assert.equal(run.status, 1, 'a tampered merge head must fail closed');
      assert.match(run.output, /stale/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('[test-runtime-inventory] merge-head contract self-test: 5 fixtures passed');
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (process.argv.includes('--check')) {
    checkInventory();
    return;
  }
  const inventory = collect(ROOT);
  const text = JSON.stringify(inventory, null, 2) + '\n';
  fs.mkdirSync(path.dirname(path.join(ROOT, OUTPUT)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUTPUT), text);
  console.log('[test-runtime-inventory] wrote ' + OUTPUT + ': ' +
    inventory.summary.entries + ' entries, ' + inventory.summary.references +
    ' references, ' + inventory.summary.unresolved + ' unresolved');
}

main();
