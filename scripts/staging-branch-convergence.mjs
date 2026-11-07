#!/usr/bin/env node
// #2926: trusted-main deployment-eligible branch discovery and PR convergence.
// Do not execute workflow files from source branches. This planner cannot merge,
// push branch refs, waive Gates, or invoke an Agent with privileged credentials.
import assert from 'node:assert/strict';
import {qualify} from './staging-convergence-readiness.mjs';
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
  // A lane must first incorporate current main. Publishing both directions
  // at once races two merge bases and risks certifying a stale promotion PR.
  if (behind > 0) return ['sync-main-to-lane'];
  if (ahead > 0) return ['promote-lane-to-main'];
  return [];
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

// Staging protection requires rust-check/web-check on an up-to-date integration
// head. A direct PR whose source is main can be mergeable yet be rejected by
// GitHub (405, required statuses expected) if staging carries independent work.
// Make a deterministic, immutable, conflict-free branch with two real parents.
export function integrationBranchName(lane, mainSha, laneSha) {
  branchName(lane);
  if(!SHA.test(mainSha)||!SHA.test(laneSha)) reject('invalid integration parent SHA');
  const normalized=lane.replace(/[\/._]/g,'-');
  const name='chore/staging-sync-'+normalized+'-'+mainSha.slice(0,12)+'-'+laneSha.slice(0,12);
  if(name.length>100)reject('integration branch name too long');
  return name;
}

function optionalRemoteHead(branch) {
  branchName(branch);
  const out=shell('git',['ls-remote','origin','refs/heads/'+branch]);
  if(!out)return null;
  const sha=out.split(/\s+/)[0];
  if(!SHA.test(sha))reject('invalid remote integration head SHA');
  return sha;
}

function ensureIntegrationBranch(repo, plan, lane) {
  const branch=integrationBranchName(lane.branch,plan.main_sha,lane.sha);
  const currentMain=gitRemoteHead('main');
  const currentLane=gitRemoteHead(lane.branch);
  if(currentMain!==plan.main_sha||currentLane!==lane.sha)
    reject('source refs moved during integration branch preparation');
  let output;
  try {
    output=shell('git',['merge-tree','--write-tree',lane.sha,plan.main_sha]);
  } catch(error) {
    if(error.status===1)return {conflict:true,branch};
    throw error;
  }
  const tree=output.trim().split(/\s+/)[0];
  if(!SHA.test(tree))reject('invalid Git merge-tree result');
  const existing=optionalRemoteHead(branch);
  if(existing) {
    shell('git',['fetch','--no-tags','origin',
      '+refs/heads/'+branch+':refs/remotes/origin/'+branch]);
    const parents=shell('git',['show','-s','--format=%P',existing]).split(/\s+/);
    const actualTree=shell('git',['rev-parse',existing+'^{tree}']);
    if(JSON.stringify(parents)!==JSON.stringify([lane.sha,plan.main_sha])||
       actualTree!==tree)reject('integration branch already exists with wrong parents/tree');
    return {branch,sha:existing,created:false};
  }
  // The App token is used only by this main-owned deterministic controller,
  // never in an Agent's context. GitHub CLI's credential helper avoids placing
  // a token in command arguments or persisting checkout credentials.
  const ident={...process.env,GIT_AUTHOR_NAME:'Nession Convergence',
    GIT_AUTHOR_EMAIL:'nession-convergence@users.noreply.github.com',
    GIT_COMMITTER_NAME:'Nession Convergence',
    GIT_COMMITTER_EMAIL:'nession-convergence@users.noreply.github.com',
    GIT_TERMINAL_PROMPT:'0'};
  const commit=shell('git',['commit-tree',tree,'-p',lane.sha,'-p',plan.main_sha,
    '-m','chore(release): integrate '+plan.main_sha+' into '+lane.sha],
    {env:ident});
  if(!SHA.test(commit))reject('invalid integration commit SHA');
  try {
    shell('git',['-c','credential.helper=!gh auth git-credential',
      'push','origin',commit+':refs/heads/'+branch],{env:ident});
  } catch(error) {
    // Concurrent controllers must not force-push or overwrite a winner. If an
    // identical immutable branch won the race, validate it below.
    if(optionalRemoteHead(branch)!==commit)throw error;
  }
  if(optionalRemoteHead(branch)!==commit)reject('integration branch push readback mismatch');
  return {branch,sha:commit,created:true};
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

export function staleGeneratedSyncPr(pr,repo,lane,currentHead) {
  return pr?.state==='open'&&pr.base?.ref===lane&&
    pr.head?.ref!==currentHead&&pr.head?.repo?.full_name===repo&&
    pr.body?.startsWith('Staging Convergence automated proposal')&&
    pr.head.ref.startsWith('chore/staging-sync-'+lane.replace(/[\/._]/g,'-')+'-');
}

function closeSupersededSyncPrs(repo,lane,currentHead) {
  const list=gh(['--method','GET','repos/'+repo+'/pulls',
    '-f','base='+lane,'-f','state=open','-f','per_page=100']);
  if(!Array.isArray(list)||list.length>=100)
    reject('unbounded active staging sync PR inventory');
  const closed=[];
  for(const pr of list) {
    if(!staleGeneratedSyncPr(pr,repo,lane,currentHead))continue;
    gh(['--method','PATCH','repos/'+repo+'/pulls/'+pr.number,'-f','state=closed']);
    closed.push(pr.number);
  }
  return closed;
}

function ensurePr(repo, owner, head, base, plan) {
  const found = existingPr(repo, owner, head, base);
  if (found) return { action: 'reused', number: found.number, url: found.html_url };
  const sync = base !== 'main';
  const title = sync
    ? 'chore(release): integrate main into ' + base + ' via checked head'
    : 'release: promote ' + head + ' to main';
  const body = [
    'Staging Convergence automated proposal (source: Release / Staging Convergence).',
    '',
    'Prepared by the trusted two-hour Staging Convergence planner.',
    '',
    '- Direction: ' + head + ' -> ' + base,
    '- Planned main SHA: ' + plan.main_sha,
    '- Planned lane SHA: ' + plan.branches.find(x => x.branch === (sync ? base : head)).sha,
    '',
    '**This PR is a proposal, not release or acceptance evidence.**',
    'Preserve merge commits; verify exact-head CI, applicable Acceptance/E2E, conflicts and deployment before merging.',
    'The controller may request a merge commit only after the independent exact-head Gates approve. It never bypasses checks, force-pushes, bumps versions or deploys Production.',
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

function dispatchConflictReview(repo, receipt, action, plan, lane) {
  const token = process.env.DISPATCH_GITHUB_TOKEN;
  if (!token) reject('the trusted Controller Actions dispatcher token is missing');
  function api(args) {
    return shell('gh', ['api', ...args], { env: { ...process.env, GH_TOKEN: token } });
  }
  const workflow = 'agent-staging-convergence-review.yml';
  // Exact SHA pair is embedded in the trusted Agent Run display title. This
  // keeps a repeatedly discovered conflict from spending tokens every tick.
  const previous = JSON.parse(api(['repos/' + repo + '/actions/workflows/' + workflow +
    '/runs?event=workflow_dispatch&per_page=100']));
  if (!Array.isArray(previous.workflow_runs) || previous.total_count > 100) {
    return { status: 'BLOCKED_UNBOUNDED_REVIEW_INVENTORY' };
  }
  const identity = 'Convergence conflict ' + lane.branch + ' ' + plan.main_sha + ' ' + lane.sha;
  const recorded = previous.workflow_runs.find(run =>
    run.display_title === identity && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' &&
    run.repository?.full_name === repo &&
    run.head_repository?.full_name === repo);
  if (recorded) return { status: 'EXISTING_ANALYSIS', run_id: recorded.id };
  api(['--method', 'POST', 'repos/' + repo + '/actions/workflows/' + workflow + '/dispatches',
    '-f', 'ref=main',
    '-f', 'inputs[pr_number]=' + receipt.number,
    '-f', 'inputs[branch]=' + lane.branch,
    '-f', 'inputs[main_sha]=' + plan.main_sha,
    '-f', 'inputs[lane_sha]=' + lane.sha,
    '-f', 'inputs[direction]=' + action]);
  return { status: 'ANALYSIS_DISPATCHED' };
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
      const sync=action==='sync-main-to-lane';
      const integration=sync?ensureIntegrationBranch(repo,plan,lane):null;
      // On an actual merge-tree conflict, the direct-source PR exists only as
      // an authenticated, SHA-bound read-only Agent analysis surface; it is not
      // qualified for merge under the protected staging rules.
      if(sync&&integration.conflict) {
        const probe=ensurePr(repo,owner,'main',lane.branch,plan);
        const result={branch:lane.branch,direction:action,...probe,
          outcome:'BLOCKED',reason:'MERGE_CONFLICT'};
        if(probe.action!=='created')
          result.agent_analysis=dispatchConflictReview(repo,probe,action,plan,lane);
        results.push(result);
        continue;
      }
      const head=sync?integration.branch:lane.branch;
      const base=sync?lane.branch:'main';
      const superseded=sync?closeSupersededSyncPrs(repo,base,head):[];
      const receipt=ensurePr(repo,owner,head,base,plan);
      const record={branch:lane.branch,direction:action,...receipt,
        ...(sync?{integration_head:integration.sha,superseded_prs:superseded}: {})};
      // A new PR needs GitHub to calculate mergeability and deliver checks.
      // Qualification and merge are considered only on a subsequent run.
      if (receipt.action === 'created') {
        record.outcome = 'AWAITING_EXACT_HEAD_CHECKS';
        results.push(record);
        continue;
      }
      const decision = qualify({action,prNumber:receipt.number,
        mainSha:plan.main_sha,laneSha:lane.sha,branch:lane.branch,
        syncRef:integration?.branch,syncHeadSha:integration?.sha,
        deployment_workflows:lane.deployment_workflows});
      if (!decision.ready) {
        record.outcome = 'BLOCKED';
        record.reason = decision.reason;
        if (decision.reason === 'MERGE_CONFLICT') {
          record.agent_analysis = dispatchConflictReview(repo, receipt, action, plan, lane);
        }
        results.push(record);
        continue;
      }
      // Never use `--auto`: acceptance might become stale before delayed merge.
      // Revalidate current refs and emit one exact-head merge request at a time.
      if (gitRemoteHead('main') !== plan.main_sha ||
          gitRemoteHead(lane.branch) !== lane.sha) {
        reject('stale head between qualification and merge: ' + lane.branch);
      }
      const expectedHead = sync ? integration.sha : lane.sha;
      const merge = gh(['--method','PUT','repos/' + repo + '/pulls/' + receipt.number + '/merge',
        '-f','merge_method=merge','-f','sha=' + expectedHead]);
      if (merge.merged !== true || !SHA.test(merge.sha)) {
        reject('GitHub declined an independently qualified merge: ' + receipt.number);
      }
      record.outcome = 'MERGED';
      record.merge_sha = merge.sha;
      results.push(record);
      // Main may now differ from the pinned plan. Never use another lane's
      // old comparison in the same run; a fresh scheduled pass will re-plan.
      if (action === 'promote-lane-to-main') return results;
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
  assert.deepEqual(deriveActions(3, 7), ['sync-main-to-lane']);
  const aa='a'.repeat(40),bb='b'.repeat(40);
  assert.equal(integrationBranchName('staging',aa,bb),
    'chore/staging-sync-staging-aaaaaaaaaaaa-bbbbbbbbbbbb');
  assert.equal(integrationBranchName('staging-01',aa,bb),
    'chore/staging-sync-staging-01-aaaaaaaaaaaa-bbbbbbbbbbbb');
  assert.throws(()=>integrationBranchName('bad..ref',aa,bb),/unsupported/);
  const sample={state:'open',base:{ref:'staging'},head:{
    ref:'chore/staging-sync-staging-aaaaaaaaaaaa-bbbbbbbbbbbb',
    repo:{full_name:'BestNathan/nession'}},
    body:'Staging Convergence automated proposal (source: Release / Staging Convergence).'};
  assert.equal(staleGeneratedSyncPr(sample,'BestNathan/nession','staging',
    'chore/staging-sync-staging-cccccccccccc-dddddddddddd'),true);
  assert.equal(staleGeneratedSyncPr(sample,'BestNathan/nession','staging',sample.head.ref),false);
  assert.equal(staleGeneratedSyncPr({...sample,body:'manual integration'},
    'BestNathan/nession','staging','another'),false);
  assert.equal(staleGeneratedSyncPr({...sample,head:{...sample.head,
    repo:{full_name:'external/fork'}}},'BestNathan/nession','staging','another'),false);
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
