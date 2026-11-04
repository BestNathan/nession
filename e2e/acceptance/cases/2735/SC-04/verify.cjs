'use strict';
// #2735 SC-04: the real macOS/APFS proof is a native execution receipt tied to
// the tested source revision. The Linux Case runner cannot execute APFS, so it
// validates the receipt's platform, measurements and revision binding. The
// receipt is produced by scripts/seed-worktree-target-macos-e2e.sh on Darwin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  run, targetSha, root,
} = require('../../../shared/worktree-seed-cases.cjs');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + String(result.stderr || '').trim());
  }
  return String(result.stdout || '');
}

run(({ evidence }) => {
  const sha = targetSha();
  const receiptPath = path.join(__dirname, 'macos-receipt.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));

  if (receipt.schema_version !== 1 || receipt.issue !== 2735 || receipt.criterion !== 'SC-04') {
    throw new Error('the receipt does not describe #2735 SC-04');
  }
  if (!/^[0-9a-f]{40}$/.test(receipt.tested_revision || '')) {
    throw new Error('the receipt has no exact tested revision');
  }
  if (receipt.platform?.os !== 'Darwin' || receipt.filesystem?.type !== 'apfs') {
    throw new Error('the receipt is not a native macOS/APFS execution');
  }
  const seed = receipt.seed || {};
  if (seed.outcome !== 'seeded' || !String(seed.strategy || '').includes('clonefile')) {
    throw new Error('the receipt does not record a CoW clone seed');
  }
  if (!(seed.logical_kib > 0) || !(seed.allocated_kib >= 0) ||
      !(seed.allocated_kib <= seed.allocation_limit_kib)) {
    throw new Error('the receipt does not prove a CoW allocation within the limit');
  }
  if (receipt.source_unchanged !== true || receipt.workspace_artifacts_removed !== true ||
      receipt.targets_private !== true) {
    throw new Error('the receipt does not record source isolation and private targets');
  }
  const build = receipt.build || {};
  if (build.exit_code !== 0) {
    throw new Error('the receipt build did not pass');
  }
  if (!Array.isArray(build.dependencies_compiled) || build.dependencies_compiled.length !== 0) {
    throw new Error('the receipt shows dependencies recompiled');
  }
  if (!Array.isArray(build.dependencies_fresh) || build.dependencies_fresh.length < 10) {
    throw new Error('the receipt does not show enough reused dependency artifacts');
  }
  if (!Array.isArray(build.workspace_compiled) || build.workspace_compiled.length === 0) {
    throw new Error('the receipt does not show workspace members rebuilding from cleaned artifacts');
  }

  // The CI checkout is shallow: the tested revision object may be absent.
  // Bind first through the receipt commit's parent SHA and the recorded seed
  // surface blobs, then use the full diff when history is available.
  if (!Array.isArray(receipt.source_paths) || receipt.source_paths.length === 0 ||
      !Array.isArray(receipt.source_tree) || receipt.source_tree.length === 0) {
    throw new Error('the receipt does not record the tested seed source surface');
  }
  const parentLine = String(git(['cat-file', '-p', 'HEAD']))
    .split('\n').find((line) => line.startsWith('parent '));
  const headParent = parentLine ? parentLine.slice('parent '.length).trim() : '';
  if (headParent !== receipt.tested_revision) {
    throw new Error('the receipt is not the commit directly after the tested revision');
  }
  const actualTree = String(git(['ls-tree', 'HEAD', '--', ...receipt.source_paths]))
    .split('\n').filter(Boolean);
  if (JSON.stringify(actualTree) !== JSON.stringify(receipt.source_tree)) {
    throw new Error('the seed source surface changed after the tested revision');
  }
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (sha256(path.join(root, 'Cargo.lock')) !== receipt.inputs.cargo_lock_sha256) {
    throw new Error('Cargo.lock changed after the tested revision');
  }
  if (sha256(path.join(root, 'rust-toolchain.toml')) !== receipt.inputs.rust_toolchain_sha256) {
    throw new Error('rust-toolchain.toml changed after the tested revision');
  }
  const parentObject = spawnSync('git', ['cat-file', '-e', receipt.tested_revision + '^{commit}'],
    { cwd: root, encoding: 'utf8' });
  if (parentObject.status === 0) {
    const changed = git(['diff', '--name-only', receipt.tested_revision + '..' + sha])
      .split('\n').filter(Boolean);
    const receiptRelative = path.relative(root, receiptPath);
    const unexpected = changed.filter((file) => file !== receiptRelative);
    if (unexpected.length > 0) {
      throw new Error('source changed after the receipt revision: ' + unexpected.join(', '));
    }
  }

  evidence.push({
    type: 'runtime',
    value: 'exact SHA ' + sha + ': native macOS receipt at ' + receipt.tested_revision + ' records seed strategy ' +
      seed.strategy + ', ' + seed.allocated_kib + ' KiB allocated for ' + seed.logical_kib + ' KiB logical ' +
      '(limit ' + seed.allocation_limit_kib + ' KiB), ' + build.dependencies_fresh.length +
      ' Fresh dependency crates, 0 recompiled dependencies and ' + build.workspace_compiled.length +
      ' rebuilt workspace members',
  });
  evidence.push({
    type: 'source',
    value: 'the receipt commit directly follows the tested revision, its recorded seed-surface Git blobs match HEAD, and Cargo.lock/toolchain hashes match the tested inputs',
  });
  return 'the native macOS/APFS run proves a CoW-backed seed and dependency reuse on first build';
});
