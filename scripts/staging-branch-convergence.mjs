#!/usr/bin/env node
// #2926: trusted-main deployment-eligible branch discovery and PR convergence.
// Do not execute workflow files from source branches. This planner cannot merge,
// push branch refs, waive Gates, or invoke an Agent with privileged credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

function reject(message) {
  throw new Error('staging convergence: ' + message);
}
function branchName(value) {
  if (typeof value !== 'string' || !SAFE_REF.test(value) ||
      value === 'main' || value.endsWith('/') || value.endsWith('.') ||
      value.includes('..') || value.includes('//') || value.includes('@{') ||
      value.endsWith('.lock') || value.split('/').some(x => x.startsWith('.'))) {
    reject('unsupported deploy-trigger branch selector: ' + JSON.stringify(value));
  }
  return value;
}
function shell(program, args, options = {}) {
  return execFileSync(program, args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}
function unquote(text) {
  const value = text.trim();
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// Narrow fail-closed parser for GitHub Actions on.push.branches. This intentionally
// rejects expressions, negations, globs, quoted "on" keys and exotic YAML rather
// than silently turning a broad selector into permission to open release PRs.
export function pushBranches(yaml) {
  const lines = yaml.split(/\r?\n/);
  const on = lines.findIndex(line => /^on:\s*(?:#.*)?$/.test(line));
  if (on < 0) return null;
  const endOn = lines.findIndex((line, i) => i > on && /^[A-Za-z][A-Za-z_-]*:/.test(line));
  const scope = lines.slice(on + 1, endOn < 0 ? undefined : endOn);
  const push = scope.findIndex(line => /^  push:\s*(?:#.*)?$/.test(line));
  if (push < 0) return null;
  const endPush = scope.findIndex((line, i) => i > push && /^  [A-Za-z_-]+:/.test(line));
  const pushScope = scope.slice(push + 1, endPush < 0 ? undefined : endPush);
  const branches = pushScope.findIndex(line => /^    branches:/.test(line));
  if (branches < 0) return null;
  const match = /^    branches:\s*(.*)$/.exec(pushScope[branches]);
  const tail = match[1].trim();
  let selected;
  if (tail.startsWith('[')) {
    const array = /^\[([^\]]*)\](?:\s*#.*)?$/.exec(tail);
    if (!array) reject('unsupported inline push.branches declaration');
    selected = array[1].split(',').map(unquote);
  } else if (!tail || tail.startsWith('#')) {
    selected = [];
    for (const line of pushScope.slice(branches + 1)) {
      if (/^    \S/.test(line)) break;
      if (/^\s*(#.*)?$/.test(line)) continue;
      const item = /^      -\s+([^#]+?)(?:\s+#.*)?$/.exec(line);
      if (!item) reject('unsupported multi-line push.branches declaration');
      selected.push(unquote(item[1]));
    }
  } else {
    reject('unsupported push.branches declaration');
  }
  if (selected.length === 0) reject('empty push.branches on a staging deployment workflow');
  return selected.map(branchName);
}

function autoDeploysStaging(content) {
  // Deployment is proven by the known GitOps writer invocation in a workflow
  // triggered by push. Manual deployments and lane E2E consumers are excluded.
  // Comments do not establish deploy eligibility.
  const uncommented = content.replace(/^\s*#.*$/gm, '');
  return /(?:^|\n)\s*(?:-\s+run:\s*)?(?:\.\/)?scripts\/gitops-commit\.sh\s+staging(?:-[0-9]+)?(?:\s|$)/.test(uncommented);
}

export function discoverDeployBranches(entries) {
  const discovered = new Map();
  for (const { file, content } of entries) {
    if (!autoDeploysStaging(content)) continue;
    const branches = pushBranches(content);
    if (!branches) continue;
    for (const branch of branches) {
      const owners = discovered.get(branch) || [];
      owners.push(file);
      discovered.set(branch, owners);
    }
  }
  if (discovered.size === 0) reject('no trusted push-triggered staging deployment branch found');
  return [...discovered].sort(([a], [b]) => a.localeCompare(b))
    .map(([branch, owners]) => ({ branch, deployment_workflows: owners.sort() }));
}

function discoverFromTree() {
  const entries = fs.readdirSync(WORKFLOWS)
    .filter(name => /^[-\w]+\.ya?ml$/.test(name))
    .map(file => ({ file, content: fs.readFileSync(path.join(WORKFLOWS, file), 'utf8') }));
  return discoverDeployBranches(entries);
}

function gitRemoteHead(branch) {
  const result = shell('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch]);
  const sha = result.split(/\s+/)[0];
  if (!SHA.test(sha)) reject('invalid remote SHA for ' + branch);
  return sha;
}

function fetchForComparison(ref) {
  shell('git', ['fetch', '--no-tags', 'origin',
    '+refs/heads/' + ref + ':refs/remotes/origin/' + ref]);
}

export function deriveActions(ahead, behind) {
  if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) {
    reject('invalid ahead/behind counters');
  }
  const actions = [];
  if (behind > 0) actions.push('sync-main-to-lane');
  if (ahead > 0) actions.push('promote-lane-to-main');
  return actions;
}

function calculatePlan() {
  const branches = discoverFromTree();
  fetchForComparison('main');
  const mainSha = shell('git', ['rev-parse', 'refs/remotes/origin/main']);
  if (!SHA.test(mainSha)) reject('invalid main SHA');
  if (mainSha !== shell('git', ['rev-parse', 'HEAD'])) {
    reject('checkout main SHA is stale relative to origin/main; reschedule on current trusted source');
  }
  const states = branches.map(({ branch, deployment_workflows }) => {
    fetchForComparison(branch);
    const sha = shell('git', ['rev-parse', 'refs/remotes/origin/' + branch]);
    if (!SHA.test(sha)) reject('invalid lane SHA');
    const ahead = Number(shell('git', ['rev-list', '--count', 'origin/main..origin/' + branch]));
    const behind = Number(shell('git', ['rev-list', '--count', 'origin/' + branch + '..origin/main']));
    return { branch, sha, ahead, behind, actions: deriveActions(ahead, behind), deployment_workflows };
  });
  return { schema_version: 1, main_sha: mainSha, branches: states };
}

function gh(args) {
  return JSON.parse(shell('gh', ['api', ...args]));
}

function validatePlan(plan) {
  if (plan.schema_version !== 1 || !SHA.test(plan.main_sha) || !Array.isArray(plan.branches)) {
    reject('invalid or unsupported plan');
  }
  const trusted = discoverFromTree().map(x => x.branch);
  const supplied = plan.branches.map(x => branchName(x.branch)).sort();
  if (JSON.stringify(trusted) !== JSON.stringify(supplied)) reject('plan deploy eligibility changed');
  for (const lane of plan.branches) {
    if (!SHA.test(lane.sha) ||
      JSON.stringify(lane.actions) !== JSON.stringify(deriveActions(lane.ahead, lane.behind))) {
      reject('plan branch state/actions invalid: ' + lane.branch);
    }
  }
}

function existingPr(repo, owner, head, base) {
  const results = gh(['--method', 'GET', 'repos/' + repo + '/pulls',
    '-f', 'head=' + owner + ':' + head, '-f', 'base=' + base,
    '-f', 'state=open', '-f', 'per_page=100']);
  if (!Array.isArray(results)) reject('unexpected GitHub PR lookup response');
  const matches = results.filter(pr => pr.head?.ref === head && pr.base?.ref === base &&
    pr.head?.repo?.full_name === repo);
  if (matches.length > 1) reject('multiple active PRs for ' + head + ' -> ' + base);
  return matches[0] || null;
}

function ensurePr(repo, owner, head, base, plan) {
  const found = existingPr(repo, owner, head, base);
  if (found) return { action: 'reused', number: found.number, url: found.html_url };
  const sync = head === 'main';
  const title = sync
    ? 'chore(release): sync main into ' + base + ' (#2926)'
    : 'release: promote ' + head + ' to main (#2926)';
  const body = [
    'Refs #2926.',
    '',
    'Prepared by the trusted two-hour Staging Convergence planner.',
    '',
    '- Direction: ' + head + ' -> ' + base,
    '- Planned main SHA: ' + plan.main_sha,
    '- Planned lane SHA: ' + plan.branches.find(x => x.branch === (sync ? base : head)).sha,
    '',
    '**This PR is a proposal, not release or acceptance evidence.**',
    'Preserve merge commits; verify exact-head CI, applicable Acceptance/E2E, conflicts and deployment before merging.',
    'The scheduler never merges this PR, changes protected refs, bumps versions or deploys Production.',
  ].join('\n');
  try {
    const created = gh(['--method', 'POST', 'repos/' + repo + '/pulls',
      '-f', 'title=' + title, '-f', 'head=' + head, '-f', 'base=' + base, '-f', 'body=' + body]);
    if (!Number.isInteger(created.number) || !created.html_url) reject('unexpected PR creation response');
    return { action: 'created', number: created.number, url: created.html_url };
  } catch (error) {
    // In case another actor created the same PR between lookup and create,
    // reconcile once without treating the duplicate as a new action.
    const after = existingPr(repo, owner, head, base);
    if (after) return { action: 'reused-race', number: after.number, url: after.html_url };
    throw error;
  }
}

function reconcile(plan) {
  validatePlan(plan);
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) reject('invalid GitHub repository identity');
  const owner = repo.split('/')[0];
  // Revalidate every remote head before any writes. A stale plan is a no-op,
  // not a green release signal and not a reason to force-rewrite a branch.
  if (gitRemoteHead('main') !== plan.main_sha ||
      plan.branches.some(x => gitRemoteHead(x.branch) !== x.sha)) {
    reject('branch head changed since plan; rerun on fresh refs (no PR writes)');
  }
  const results = [];
  for (const lane of plan.branches) {
    for (const action of lane.actions) {
      const head = action === 'sync-main-to-lane' ? 'main' : lane.branch;
      const base = action === 'sync-main-to-lane' ? lane.branch : 'main';
      const receipt = ensurePr(repo, owner, head, base, plan);
      results.push({ branch: lane.branch, direction: action, ...receipt });
    }
  }
  return results;
}

function selfTest() {
  const deploy = [
    'name: Release / Staging Artifacts', 'on:', '  push:',
    "    branches: ['staging']", '  workflow_dispatch:',
    'jobs:', '  deploy-staging-gitops:', '    steps:',
    '      - run: ./scripts/gitops-commit.sh staging abc1234',
  ].join('\n');
  assert.deepEqual(pushBranches(deploy), ['staging']);
  assert.deepEqual(pushBranches(deploy.replace("['staging']", "\n      - staging\n      - integration/staging")),
    ['staging', 'integration/staging']);
  assert.deepEqual(discoverDeployBranches([
    { file: 'release-staging.yml', content: deploy },
    { file: 'deploy-manual.yml', content: 'on:\n  workflow_dispatch:\njobs:\n  deploy-staging-gitops:\n    steps:\n      - run: ./scripts/gitops-commit.sh staging deadbeef' },
    { file: 'test.yml', content: deploy.replace('gitops-commit.sh staging', 'gitops-commit.sh production') },
  ]), [{ branch: 'staging', deployment_workflows: ['release-staging.yml'] }]);
  assert.deepEqual(discoverDeployBranches([
    { file: 'release-staging.yml', content: deploy },
    { file: 'deploy-staging-01.yml', content: deploy
      .replace("['staging']", "['staging-01']")
      .replace('deploy-staging-gitops:', 'deploy-staging-01:')
      .replace('gitops-commit.sh staging ', 'gitops-commit.sh staging-01 ') },
  ]).map(x => x.branch), ['staging', 'staging-01']);
  assert.throws(() => pushBranches(deploy.replace("['staging']", "['staging*']")), /unsupported/);
  assert.throws(() => pushBranches(deploy.replace("['staging']", "['!main']")), /unsupported/);
  assert.throws(() => pushBranches(deploy.replace("['staging']", "['main']")), /unsupported/);
  assert.throws(() => pushBranches(deploy.replace("['staging']", "${{ vars.STAGING_BRANCHES }}")), /unsupported/);
  assert.deepEqual(deriveActions(0, 0), []);
  assert.deepEqual(deriveActions(4, 0), ['promote-lane-to-main']);
  assert.deepEqual(deriveActions(0, 5), ['sync-main-to-lane']);
  assert.deepEqual(deriveActions(3, 7), ['sync-main-to-lane', 'promote-lane-to-main']);
  assert.throws(() => deriveActions(-1, 0), /invalid/);
  process.stdout.write('staging convergence self-test: PASS\n');
}

const [, , mode, output] = process.argv;
if (mode === 'self-test') selfTest();
else if (mode === 'discover') process.stdout.write(JSON.stringify(discoverFromTree(), null, 2) + '\n');
else if (mode === 'plan') {
  if (!output) reject('plan requires output JSON path');
  const plan = calculatePlan();
  fs.writeFileSync(output, JSON.stringify(plan, null, 2) + '\n');
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
} else if (mode === 'reconcile') {
  if (!output) reject('reconcile requires a plan JSON path');
  const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
  process.stdout.write(JSON.stringify(reconcile(plan), null, 2) + '\n');
} else reject('usage: self-test | discover | plan <out.json> | reconcile <plan.json>');
