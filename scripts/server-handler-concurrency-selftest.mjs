#!/usr/bin/env node
// Issue #1258, SC-12: real isolated Git worktrees modify two unrelated
// versioned handler implementations and merge without editing a common file.
// Structural merge scenario only; this is not an AI productivity measurement.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const FILES = [
  'crates/nession-server/src/server/handler/server_agent_rename_v1.rs',
  'crates/nession-server/src/server/handler/server_env_write_v1.rs',
];
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const temp = mkdtempSync(join(tmpdir(), 'nession-handler-concurrency-'));
try {
  const base = join(temp, 'fixture');
  mkdirSync(base);
  const original = FILES.map(path => {
    const dst = join(base, path);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(ROOT, path), dst);
    return readFileSync(dst, 'utf8');
  });
  git(base, 'init', '-q', '-b', 'baseline');
  git(base, 'config', 'user.name', 'Nession Locality CI');
  git(base, 'config', 'user.email', 'ci@nession.local');
  git(base, 'add', '--', ...FILES);
  git(base, 'commit', '-q', '-m', 'baseline: exact versioned handler source snapshot');
  const baseline = git(base, 'rev-parse', 'HEAD');
  const agent = join(temp, 'agent-worktree');
  const env = join(temp, 'env-worktree');
  git(base, 'worktree', 'add', '-q', '-b', 'change-agent', agent, baseline);
  git(base, 'worktree', 'add', '-q', '-b', 'change-env', env, baseline);

  // Two independent edits with the same source SHA and separate branches.
  // Comments prevent behavior changes; source-location/merge is the invariant.
  const editAgent = '\n// SC-12: isolated change to server.agent.rename@v1\n';
  const editEnv = '\n// SC-12: isolated change to server.env.write@v1\n';
  writeFileSync(join(agent, FILES[0]), original[0] + editAgent);
  writeFileSync(join(env, FILES[1]), original[1] + editEnv);
  git(agent, 'add', '--', FILES[0]);
  git(agent, 'commit', '-q', '-m', 'test: independent agent Unit edit');
  git(env, 'add', '--', FILES[1]);
  git(env, 'commit', '-q', '-m', 'test: independent env Unit edit');

  const changed = branch => git(base, 'diff', '--name-only', 'baseline..' + branch).split('\n').filter(Boolean);
  const pathsA = changed('change-agent'), pathsB = changed('change-env');
  const overlap = pathsA.filter(path => pathsB.includes(path));
  if (pathsA.length !== 1 || pathsA[0] !== FILES[0] ||
      pathsB.length !== 1 || pathsB[0] !== FILES[1] || overlap.length)
    throw Error('unexpected shared-file edits: ' + JSON.stringify({ pathsA, pathsB, overlap }));

  git(agent, 'merge', '--no-ff', '--no-edit', 'change-env');
  const parents = git(agent, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
  if (parents.length !== 3) throw Error('expected a genuine two-parent Git merge');
  const mergedPaths = git(agent, 'diff', '--name-only', 'baseline..HEAD').split('\n').filter(Boolean).sort();
  if (JSON.stringify(mergedPaths) !== JSON.stringify([...FILES].sort()) ||
      readFileSync(join(agent, FILES[0]), 'utf8') !== original[0] + editAgent ||
      readFileSync(join(agent, FILES[1]), 'utf8') !== original[1] + editEnv)
    throw Error('merge lost a Unit edit or included unrelated files');

  console.log(JSON.stringify({
    scenario: '1258-independent-versioned-handler-worktrees',
    result: 'PASS',
    sourceSha: process.env.GITHUB_SHA ?? 'local',
    baselineFixtureCommit: baseline,
    agent: { branch: 'change-agent', files: pathsA, originalContentSha256: hash(original[0]) },
    env: { branch: 'change-env', files: pathsB, originalContentSha256: hash(original[1]) },
    sharedChangedFiles: overlap,
    mergeCommit: git(agent, 'rev-parse', 'HEAD'),
    mergeParents: parents.slice(1),
    mergedFiles: mergedPaths,
    limitations: 'deterministic source/merge proof; no runtime or model efficiency claim',
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
