#!/usr/bin/env node
// #2926: trusted-main deployment-eligible branch discovery and PR convergence.
// Do not execute workflow files from source branches. This planner cannot merge,
// push branch refs, waive Gates, or invoke an Agent with privileged credentials.
import assert from 'node:assert/strict';
import {qualify} from './staging-convergence-readiness.mjs';
import {planBatch,findBatchIssue,issueApproval} from './staging-convergence-batch.mjs';
import {isNativeConvergencePr,convergencePrMarker,convergenceBatchDigest,
  convergenceApproval,fullRegressionTitle,latestConvergenceFull,
  attestConvergenceFull} from './staging-convergence-pr.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
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

// The existing Publisher App identity only has Contents/PR write, not Issue
// write. Legacy Issue cleanup uses the separate GitHub Actions issues:write
// token, narrowly scoped to the trusted cleanup calls below.
function ghIssueWrite(args) {
  const token=process.env.ISSUE_GITHUB_TOKEN;
  if(!token)reject('trusted Issue cleanup token unavailable');
  return JSON.parse(shell('gh',['api',...args],{
    env:{...process.env,GH_TOKEN:token}
  }));
}
export function legacyIssueArchiveRequests(repo,number,prNumber,headSha) {
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||
      !Number.isSafeInteger(number)||number<=0||
      !Number.isSafeInteger(prNumber)||prNumber<=0||!SHA.test(headSha))
    reject('invalid legacy Issue archive provenance');
  const resource='repos/'+repo+'/issues/'+number;
  return [
    ['--method','POST',resource+'/comments','-f',
      'body=Superseded by PR-native Staging integration #'+prNumber+
      ' (checked head '+headSha+'). This historical per-SHA batch '+
      'is not an open product Requirement; no evidence or old approval was reused.'],
    ['--method','PATCH',resource,'-f','state=closed','-f','state_reason=not_planned'],
  ];
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

// Keep a checked two-parent integration PR alive while Main advances. Only a
// changed Staging first parent, broken ancestry, or invalid head invalidates it.
export function pinnedSyncIdentity(pr,repo,lane,laneSha,headSha,parents,mainIsAncestor) {
  const prefix='chore/staging-sync-'+lane.replace(/[\\/._]/g,'-')+'-';
  if(pr?.state!=='open'||pr.draft||pr.base?.ref!==lane||
      pr.head?.repo?.full_name!==repo||!pr.head?.ref?.startsWith(prefix)||
      !pr.body?.startsWith('Staging Convergence automated proposal')||
      !SHA.test(pr.head?.sha||'')||pr.head.sha!==headSha||
      !Array.isArray(parents)||parents.length!==2||
      parents[0]!==laneSha||!SHA.test(parents[1]||'')||
      !mainIsAncestor)return false;
  return pr.head.ref===integrationBranchName(lane,parents[1],laneSha);
}
function pendingSyncIntegration(repo,lane,liveMainSha) {
  const opened=gh(['--method','GET','repos/'+repo+'/pulls',
    '-f','base='+lane.branch,'-f','state=open','-f','per_page=100']);
  if(!Array.isArray(opened)||opened.length>=100)
    reject('unbounded active Staging PR inventory');
  const prefix='chore/staging-sync-'+lane.branch.replace(/[\\/._]/g,'-')+'-';
  const generated=opened.filter(pr=>pr.state==='open'&&
    pr.base?.ref===lane.branch&&pr.head?.repo?.full_name===repo&&
    pr.head?.ref?.startsWith(prefix)&&
    pr.body?.startsWith('Staging Convergence automated proposal'));
  if(generated.length>1)reject('multiple generated sync PRs; resolve before continuing');
  const pr=generated[0];
  if(!pr)return null;
  // Changed staging requires a new approval and exact-head check. The
  // obsolete PR is closed by the existing supersession path, not reused.
  if(pr.base?.sha!==lane.sha)return null;
  const remote=optionalRemoteHead(branchName(pr.head.ref));
  if(remote!==pr.head?.sha)reject('active sync PR ref does not match GitHub head');
  fetchForComparison(pr.head.ref);
  const parents=shell('git',['show','-s','--format=%P',remote]).split(/\s+/);
  const pinnedMain=parents[1];
  let mainIsAncestor=false;
  if(SHA.test(pinnedMain||'')){
    try{shell('git',['merge-base','--is-ancestor',pinnedMain,liveMainSha]);
      mainIsAncestor=true;
    }catch(error){if(error.status!==1)throw error;}
  }
  if(!pinnedSyncIdentity(pr,repo,lane.branch,lane.sha,remote,parents,mainIsAncestor))
    reject('active sync PR has invalid pinned ancestry or identity');
  const tree=shell('git',['merge-tree','--write-tree',lane.sha,pinnedMain]).split(/\s+/)[0];
  if(!SHA.test(tree)||shell('git',['rev-parse',remote+'^{tree}'])!==tree)
    reject('active sync integration tree differs from trusted source');
  return {branch:pr.head.ref,sha:remote,main_sha:pinnedMain,created:false,reused:true,
    pr,native:isNativeConvergencePr(pr)};
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

function ensurePr(repo, owner, head, base, plan, batchIssueNumber=null, batch=null) {
  const found = existingPr(repo, owner, head, base);
  if (found) {
    if(batch&&!batchIssueNumber&&!found.body?.includes(convergencePrMarker(batch)))
      reject('existing PR is not a source-bound native convergence batch');
    // Only automation-owned PRs may have their missing source association
    // repaired. A body edit never counts as a successful E2E re-run.
    if(batchIssueNumber && !found.body?.includes('Refs #'+batchIssueNumber)) {
      if(!found.body?.startsWith('Staging Convergence automated proposal') ||
         !found.head?.ref.startsWith('chore/staging-sync-'))
        reject('untrusted preexisting integration PR cannot be relinked');
      gh(['--method','PATCH','repos/'+repo+'/pulls/'+found.number,
        '-f','body='+found.body+'\n\nRefs #'+batchIssueNumber]);
      return {action:'relinked',number:found.number,url:found.html_url};
    }
    return { action: 'reused', number: found.number, url: found.html_url };
  }
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
    ...(batchIssueNumber ? ['', 'Refs #'+batchIssueNumber] :
      batch ? ['', '- Historical changed paths: '+batch.changedPaths.length,
        '- Source risk: '+batch.impact.category,
        '- Selected E2E IDs: '+([...batch.newIds,...batch.regressionIds].join(', ')||'none'),
        '',convergencePrMarker(batch)] : []),
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

// Trusted, exact-source Full E2E is the automated substitute for manual
// approval of a risk-bearing source batch. A completed failing Full blocks;
// no manual comment, extra dispatch or stale historical green waives it.
function nativeFullDecision(repo,batch,sourcePr){
  const policy=convergenceApproval(batch);
  if(policy.approved||policy.reason!=='AWAITING_EXACT_HEAD_FULL_E2E')
    return policy;
  const reader=process.env.READ_GITHUB_TOKEN;
  const dispatcher=process.env.DISPATCH_GITHUB_TOKEN;
  if(!reader||!dispatcher)reject('trusted Full evidence tokens unavailable');
  const since=String(sourcePr.created_at??'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(since))
    reject('native source PR creation fence missing');
  const readArgs={env:{...process.env,GH_TOKEN:reader}};
  const inventory=JSON.parse(shell('gh',['api','--method','GET',
    'repos/'+repo+'/actions/workflows/e2e-full-regression.yml/runs',
    '-f','event=workflow_dispatch','-f','created=>='+since,
    '-f','per_page=100'],readArgs));
  if(!Array.isArray(inventory.workflow_runs)||inventory.workflow_runs.length>=100)
    reject('unbounded native Full E2E inventory; no approval granted');
  const run=latestConvergenceFull(batch,inventory.workflow_runs);
  if(!run){
    shell('gh',['api','--method','POST',
      'repos/'+repo+'/actions/workflows/e2e-full-regression.yml/dispatches',
      '-f','ref=main',
      '-f','inputs[target_ref]='+sourcePr.head.ref,
      '-f','inputs[target_sha]='+batch.integration_head],
      {env:{...process.env,GH_TOKEN:dispatcher}});
    return {approved:false,reason:'EXACT_HEAD_FULL_E2E_DISPATCHED',
      full_run_title:fullRegressionTitle(batch)};
  }
  if(run.status!=='completed')return {approved:false,
    reason:'AWAITING_EXACT_HEAD_FULL_E2E',full_run_id:run.id};
  if(run.conclusion!=='success')return {approved:false,
    reason:'EXACT_HEAD_FULL_E2E_FAILED',full_run_id:run.id,
    full_run_url:run.html_url};
  const jobs=JSON.parse(shell('gh',['api','--method','GET',
    'repos/'+repo+'/actions/runs/'+run.id+'/attempts/'+
      run.run_attempt+'/jobs','-f','per_page=100'],readArgs));
  if(!Array.isArray(jobs.jobs)||jobs.jobs.length>=100)
    reject('unbounded exact-attempt Full E2E jobs');
  const receipt=attestConvergenceFull(batch,run,jobs.jobs);
  const result=convergenceApproval(batch,receipt);
  return {...result,full_run_id:run.id,full_run_url:run.html_url};
}

function dispatchBatchAudit(repo,issue){
  const token=process.env.DISPATCH_GITHUB_TOKEN;
  if(!token)reject('trusted Issue Audit dispatcher token missing');
  const env={...process.env,GH_TOKEN:token};
  // A dispatch can succeed remotely while the Controller loses its reply.
  // Reconcile the immutable Issue identity against actual GitHub runs before
  // spending another model invocation; do not rely on the created flag.
  const raw=shell('gh',['api','repos/'+repo+
    '/actions/workflows/agent-issue-audit.yml/runs?event=workflow_dispatch&per_page=100'],{env});
  const inventory=JSON.parse(raw);
  if(!Array.isArray(inventory.workflow_runs))reject('untrusted Issue Audit run inventory');
  const expected='Issue Audit #'+issue.number;
  const found=inventory.workflow_runs.find(run=>run.display_title===expected&&
    run.event==='workflow_dispatch'&&run.head_branch==='main'&&
    run.repository?.full_name===repo&&run.head_repository?.full_name===repo&&
    Date.parse(run.created_at)>=Date.parse(issue.created_at));
  if(found)return {status:'EXISTING_AUDIT',run_id:found.id};
  if(inventory.workflow_runs.length===100 &&
    Date.parse(inventory.workflow_runs[99].created_at)>Date.parse(issue.created_at))
    return {status:'BLOCKED_AUDIT_RUN_INVENTORY_TRUNCATED'};
  shell('gh',['api','--method','POST','repos/'+repo+
    '/actions/workflows/agent-issue-audit.yml/dispatches',
    '-f','ref=main','-f','inputs[issue_number]='+issue.number],{env});
  return {status:'AUDIT_DISPATCHED'};
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

// One-time transition: preserve already-approved legacy batches but retire
// unapproved Issue-backed PRs so the lane cannot remain stuck forever behind
// the old Issue approval model. No approved source SHA is silently abandoned.
export function shouldMigrateLegacy(pinned,approval){
  return Boolean(pinned&&!pinned.native&&!approval?.approved);
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
      let pinned=sync?pendingSyncIntegration(repo,lane,plan.main_sha):null;
      let legacyRetirement=null;
      if(sync&&pinned&&!pinned.native){
        const oldBatch=planBatch({branch:lane.branch,main_sha:pinned.main_sha,
          lane_sha:lane.sha,integration_head:pinned.sha});
        const oldIssue=findBatchIssue(oldBatch);
        const oldApproval=oldIssue?issueApproval(oldBatch,oldIssue.number):null;
        if(shouldMigrateLegacy(pinned,oldApproval)){
          legacyRetirement={pinned,batch:oldBatch,issue:oldIssue};
          pinned=null; // use the latest Main, mint one native PR instead
        }
      }
      const syncMainSha=pinned?.main_sha||plan.main_sha;
      const integration=sync?(pinned||ensureIntegrationBranch(repo,
        {...plan,main_sha:syncMainSha},lane)):null;
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
      let batch=null,batchIssueNumber=null;
      const legacy=sync&&pinned&&!pinned.native;
      if(sync){
        // Always verify the same exact historical test obligations. New
        // integrations keep this digest on their PR and never mint an Issue.
        fetchForComparison(integration.branch);
        batch=planBatch({branch:lane.branch,main_sha:syncMainSha,
          lane_sha:lane.sha,integration_head:integration.sha});
        if(legacy){
          // Transitional, already-open Issue-backed PRs remain valid until
          // merged or superseded. NEVER create a new legacy batch Issue.
          const existing=findBatchIssue(batch);
          if(!existing)reject('legacy integration PR has no existing source Issue');
          batchIssueNumber=existing.number;
          const approval=issueApproval(batch,batchIssueNumber);
          if(!approval.approved){
            const audit=dispatchBatchAudit(repo,existing);
            if(audit.status==='BLOCKED_AUDIT_RUN_INVENTORY_TRUNCATED')
              reject('legacy Issue Audit inventory truncated');
          }
        }
      }
      const head=sync?integration.branch:lane.branch;
      const base=sync?lane.branch:'main';
      // Re-read the exact owner comment before retiring any still-open
      // historical batch. An approval arriving during planning wins; abort
      // and allow the next run to consume its immutable legacy PR.
      if(legacyRetirement?.issue){
        const approved=issueApproval(legacyRetirement.batch,
          legacyRetirement.issue.number);
        if(approved.approved)reject('legacy approval raced migration; rerun');
      }
      const superseded=sync?closeSupersededSyncPrs(repo,base,head):[];
      if(legacyRetirement&&legacyRetirement.pinned.branch===head){
        const old=gh(['--method','GET','repos/'+repo+'/pulls/'+
          legacyRetirement.pinned.pr.number]);
        if(old.state==='open'){
          if(old.head?.sha!==legacyRetirement.pinned.sha)
            reject('legacy head changed during native migration');
          gh(['--method','PATCH','repos/'+repo+'/pulls/'+old.number,
            '-f','state=closed']);
          superseded.push(old.number);
        }
      }
      const receipt=ensurePr(repo,owner,head,base,plan,batchIssueNumber,batch);
      if(legacyRetirement?.issue&&superseded.includes(
        legacyRetirement.pinned.pr.number)){
        for(const request of legacyIssueArchiveRequests(repo,
          legacyRetirement.issue.number,receipt.number,integration.sha))
          ghIssueWrite(request);
      }
      const record={branch:lane.branch,direction:action,...receipt,
        ...(sync?{integration_head:integration.sha,
          batch_digest:convergenceBatchDigest(batch),
          approval_source:legacy?'legacy_issue':'native_pr',
          ...(legacy?{issue_number:batchIssueNumber}:{}),
          superseded_prs:superseded,
          ...(legacyRetirement?.issue?{retired_legacy_issue:legacyRetirement.issue.number}:{})}: {})};
      // A new PR needs GitHub to calculate mergeability and deliver checks.
      // Qualification and merge are considered only on a subsequent run.
      if (receipt.action === 'created'||receipt.action === 'relinked') {
        record.outcome = 'AWAITING_EXACT_HEAD_CHECKS';
        results.push(record);
        continue;
      }
      if(sync){
        let approval;
        if(legacy)approval=issueApproval(batch,batchIssueNumber);
        else{
          const sourcePr=gh(['--method','GET','repos/'+repo+'/pulls/'+receipt.number]);
          if(sourcePr.head?.sha!==integration.sha||
             !sourcePr.body?.includes(convergencePrMarker(batch)))
            reject('native sync PR source/digest mismatch before approval');
          approval=nativeFullDecision(repo,batch,sourcePr);
        }
        if(!approval.approved){
          record.outcome='BLOCKED';
          record.reason=approval.reason;
          if(legacy)record.issue_approval_command=approval.approval_command;
          else{
            if(approval.full_run_id)record.full_run_id=approval.full_run_id;
            if(approval.full_run_url)record.full_run_url=approval.full_run_url;
            if(approval.full_run_title)record.full_run_title=approval.full_run_title;
          }
          results.push(record);
          continue;
        }
      }
      const decision = qualify({action,prNumber:receipt.number,
        mainSha:syncMainSha,laneSha:lane.sha,branch:lane.branch,
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
      // Main can advance without invalidating the checked integration.
      // Its pinned second parent must remain an ancestor of Main; the Staging
      // first parent must match exactly. No head rewrite or approval reuse.
      const liveMain=gitRemoteHead('main');
      let pinnedAncestor=false;
      if(sync){
        try{shell('git',['merge-base','--is-ancestor',syncMainSha,liveMain]);
          pinnedAncestor=true;
        }catch(error){if(error.status!==1)throw error;}
      }
      if (gitRemoteHead(lane.branch)!==lane.sha ||
          (sync&&!pinnedAncestor)||(!sync&&liveMain!==plan.main_sha)) {
        reject('stale or divergent sources before merge: '+lane.branch);
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
  // A YAML comment indented *inside* an `if: >-` block scalar is not a
  // comment: GitHub parses it as part of the job expression and rejects the
  // entire workflow before any job is created (#2953, run 42569835883).
  const workflow = fs.readFileSync(
    path.join(WORKFLOWS, 'release-staging-convergence.yml'), 'utf8');
  const jobIf = /^    if: >-\n((?:^ {6,}[^\n]*\n)+)/m.exec(workflow);
  assert.ok(jobIf, 'staging convergence must retain the guarded job expression');
  assert.doesNotMatch(jobIf[1], /^\s*#/m,
    'YAML comment is embedded in GitHub job-if folded expression');
  // #3205: production workflow_run guard must allow both the historical
  // static workflow name and GitHub's observed dynamic run-name (equal to
  // display_title) for exact-source Convergence Full dispatches. The actual
  // Full verifier separately attests pinned PR/Run/Job/Steps.
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.name == 'E2E \/ Full Regression'/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.name == github\.event\.workflow_run\.display_title/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.path == '\.github\/workflows\/e2e-full-regression\.yml'/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(jobIf[1],
    /startsWith\(github\.event\.workflow_run\.display_title, 'Convergence Full chore\/staging-sync-'\)/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(jobIf[1],
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  // #3211: an authenticated completion for the native Staging -> Main PR
  // must wake the same trusted controller (not require owner/schedule).
  assert.match(jobIf[1],/github\.event\.workflow_run\.head_branch == 'staging'/);
  assert.match(jobIf[1],/github\.event\.workflow_run\.pull_requests\[0\]\.head\.ref == 'staging'/);
  assert.match(jobIf[1],/github\.event\.workflow_run\.pull_requests\[0\]\.base\.ref == 'main'/);
  assert.match(jobIf[1],/github\.event\.workflow_run\.event == 'pull_request'/);
  // #3247: prove the actual workflow job-if accepts the authenticated
  // post-deployment completion, not merely a copied JS approximation.
  assert.match(workflow,
    /workflows: \[[^\n]*'Release \/ Staging Artifacts'[^\n]*\]/);
  const releaseWake = {
    event: 'push',
    name: 'Release / Staging Artifacts',
    path: '.github/workflows/release-staging.yml',
    head_branch: 'staging',
    conclusion: 'success',
    repository: {full_name: 'BestNathan/nession'},
    head_repository: {full_name: 'BestNathan/nession'},
    pull_requests: [],
  };
  const acceptsWake = (source, root={}) => vm.runInNewContext(
    jobIf[1], {
      github: {
        repository: 'BestNathan/nession', repository_owner: 'BestNathan',
        ref: 'refs/heads/main', event_name: 'workflow_run',
        event: {workflow_run: source}, ...root,
      },
      startsWith: (value, prefix) =>
        typeof value === 'string' && value.startsWith(prefix),
    }, {timeout: 1000});
  assert.equal(acceptsWake(releaseWake), true,
    'the canonical staging push release success must re-wake convergence');
  const refusedWake = [
    {event: 'workflow_dispatch'},
    {name: 'Release / Staging Artifacts (forged)'},
    {path: '.github/workflows/foreign.yml'},
    {head_branch: 'main'},
    {head_branch: 'integration/staging'},
    {conclusion: 'failure'},
    {conclusion: 'skipped'},
    {head_repository: {full_name: 'attacker/fork'}},
    {repository: {full_name: 'attacker/fork'}},
  ];
  for (const mutation of refusedWake) {
    assert.equal(acceptsWake({...releaseWake, ...mutation}), false,
      'untrusted Staging release wake must not start convergence: '+
        JSON.stringify(mutation));
  }
  assert.equal(acceptsWake(releaseWake, {ref:'refs/heads/staging'}), false,
    'only protected main may run the release controller');
  assert.equal(acceptsWake(releaseWake, {repository:'attacker/fork'}), false,
    'the wake must not execute in an unrelated repository');
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
  const pinned={...sample,base:{ref:'staging',sha:bb},
    head:{...sample.head,sha:'c'.repeat(40)}};
  assert.equal(pinnedSyncIdentity(pinned,'BestNathan/nession','staging',
    bb,'c'.repeat(40),[bb,aa],true),true);
  assert.equal(pinnedSyncIdentity(pinned,'BestNathan/nession','staging',
    bb,'c'.repeat(40),[bb,aa],false),false,'divergent Main must block');
  assert.equal(pinnedSyncIdentity(pinned,'BestNathan/nession','staging',
    aa,'c'.repeat(40),[bb,aa],true),false,'changed Staging must block');
  assert.equal(pinnedSyncIdentity(pinned,'BestNathan/nession','staging',
    bb,'d'.repeat(40),[bb,aa],true),false,'head mismatch must block');
  assert.equal(pinnedSyncIdentity(pinned,'BestNathan/nession','staging',
    bb,'c'.repeat(40),[aa,bb],true),false,'parent inversion must block');
  assert.equal(pinnedSyncIdentity({...pinned,head:{...pinned.head,
    repo:{full_name:'attacker/fork'}}},'BestNathan/nession','staging',
    bb,'c'.repeat(40),[bb,aa],true),false,'fork must block');
  assert.equal(pinnedSyncIdentity({...pinned,body:'manual integration'},'BestNathan/nession',
    'staging',bb,'c'.repeat(40),[bb,aa],true),false,'manual PR cannot be adopted');
  assert.equal(shouldMigrateLegacy({native:false},{approved:false}),true);
  assert.equal(shouldMigrateLegacy({native:false},{approved:true}),false,
    'existing owner-approved PR must not be discarded');
  assert.equal(shouldMigrateLegacy({native:true},{approved:false}),false,
    'native PR cannot be treated as legacy');
  const archive=legacyIssueArchiveRequests('BestNathan/nession',3159,3168,
    'a'.repeat(40));
  assert.equal(archive.length,2);
  assert.deepEqual(archive[0].slice(0,3),
    ['--method','POST','repos/BestNathan/nession/issues/3159/comments']);
  assert.deepEqual(archive[1].slice(0,3),
    ['--method','PATCH','repos/BestNathan/nession/issues/3159']);
  assert.throws(()=>legacyIssueArchiveRequests('attacker/repo',0,3168,
    'a'.repeat(40)),/invalid legacy Issue archive provenance/);
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
