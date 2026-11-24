#!/usr/bin/env node
// #3656: read-only diagnostics for the *effective* protected PR merge candidate.
// This does not grant merge authority, publish a status or replace GitHub's decision.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const REPO = 'BestNathan/nession';
const SHA = /^[0-9a-f]{40}$/;
const OK = new Set(['success', 'neutral']);
const checkSha = value => typeof value === 'string' && SHA.test(value);

export function requiredContexts(branch, rules) {
  if (branch?.protected !== true || !Array.isArray(rules))
    throw Error('PROTECTION_UNVERIFIED');
  if (rules.length >= 100) throw Error('EFFECTIVE_RULESET_INVENTORY_UNBOUNDED');
  const classic = branch.protection?.required_status_checks;
  if (classic && classic.enforcement_level !== 'everyone')
    throw Error('PROTECTION_NOT_ENFORCED');
  const result = new Map();
  const add = (name, app) => {
    if (typeof name !== 'string' || !name.trim())
      throw Error('REQUIRED_CONTEXT_INVALID');
    if (app !== null && (!Number.isSafeInteger(app) || app <= 0))
      throw Error('REQUIRED_APP_INVALID');
    if (result.has(name) && result.get(name) !== app)
      throw Error('REQUIRED_APP_CONFLICT:' + name);
    result.set(name, app);
  };
  if (classic) {
    if (Array.isArray(classic.checks) && classic.checks.length) {
      for (const c of classic.checks) add(c.context, c.app_id ?? null);
    } else if (Array.isArray(classic.contexts)) {
      // Names alone do not reveal whether an App source is pinned.
      // A context-only view is insufficient for SC-01 provenance.
      throw Error('CLASSIC_CHECK_APP_UNVERIFIED');
    } else throw Error('CLASSIC_CHECKS_UNREADABLE');
  }
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks))
      throw Error('RULESET_CHECKS_UNREADABLE');
    for (const c of checks) add(c.context, c.integration_id ?? null);
  }
  if (!result.size) throw Error('REQUIRED_CONTEXTS_UNVERIFIED');
  return result;
}

export function inspectProtectedCandidate(s) {
  const problems = [];
  const pr = s?.pr, branch = s?.branch;
  if (pr?.state !== 'open' || !['main', 'staging'].includes(pr?.base?.ref) ||
      pr?.base?.repo?.full_name !== REPO ||
      pr?.head?.repo?.full_name !== REPO ||
      !checkSha(pr.head.sha) || !checkSha(pr.base.sha) ||
      !checkSha(branch?.commit?.sha)) {
    return {state:'PENDING', candidate:null, problems:['PR_IDENTITY_UNVERIFIED']};
  }
  if (pr.base.sha !== branch.commit.sha)
    problems.push('STALE_BASE');
  if (!checkSha(pr.merge_commit_sha) || !s.mergeCommit ||
      s.mergeCommit.sha !== pr.merge_commit_sha ||
      s.mergeCommit.parents?.length !== 2 ||
      s.mergeCommit.parents[0].sha !== branch.commit.sha ||
      s.mergeCommit.parents[1].sha !== pr.head.sha)
    problems.push('STALE_OR_UNVERIFIED_TEST_MERGE');

  let required;
  try { required = requiredContexts(branch, s.rules); }
  catch (error) {
    problems.push(error.message);
    return {state:'PENDING', candidate:null, problems};
  }
  const merge = s.mergeEvidence;
  const head = s.headEvidence;
  if (!Array.isArray(merge?.checks) || !Array.isArray(merge?.statuses) ||
      !Array.isArray(head?.checks) || !Array.isArray(head?.statuses))
    return {state:'PENDING', candidate:null, problems:[...problems, 'CHECK_INVENTORY_UNVERIFIED']};
  // GitHub prefers the test merge when it has reported checks. HEAD success
  // must not launder a missing required context on the merge candidate.
  const isMerge = merge.checks.length + merge.statuses.length > 0;
  const candidate = isMerge ? pr.merge_commit_sha : pr.head.sha;
  const inventory = isMerge ? merge : head;
  for (const [context, appId] of required) {
    const checks = inventory.checks.filter(c => c.name === context)
      .sort((a,b) => b.id - a.id);
    const statuses = inventory.statuses.filter(c => c.context === context)
      .sort((a,b) => b.id - a.id);
    if (!checks.length && !statuses.length) {
      problems.push('MISSING_REQUIRED_CONTEXT:' + context);
      continue;
    }
    if (checks.length) {
      const c = checks[0];
      if (c.head_sha !== candidate)
        problems.push('WRONG_CHECK_SHA:' + context);
      else if (appId !== null && c.app?.id !== appId)
        problems.push('WRONG_CHECK_APP:' + context);
      else if (c.status !== 'completed')
        problems.push('INCOMPLETE_CHECK:' + context);
      else if (c.conclusion === 'skipped')
        problems.push('SCOPED_SKIP_REQUIRES_SCOPE_PROOF:' + context);
      else if (!OK.has(c.conclusion))
        problems.push('FAILED_CHECK:' + context);
    }
    // GitHub requires both when a Check Run and a Commit Status share a name.
    // Commit Status GET does not expose a reliable App ID; never claim a
    // source-app-pinned status is fully attested from creator.login alone.
    if (statuses.length) {
      const c = statuses[0];
      if (c.sha && c.sha !== candidate)
        problems.push('WRONG_STATUS_SHA:' + context);
      else if (c.state !== 'success')
        problems.push('FAILED_STATUS:' + context);
      if (appId !== null)
        problems.push('STATUS_APP_PROVENANCE_UNVERIFIED:' + context);
    }
  }
  return {state:problems.length ? 'PENDING' : 'READY_FOR_GITHUB_RECHECK',
    candidate, checked_head:pr.head.sha, checked_base:branch.commit.sha,
    required:[...required.keys()], problems};
}

function api(path) {
  return JSON.parse(execFileSync('gh', ['api', path], {
    encoding:'utf8',maxBuffer:8_000_000,stdio:['ignore','pipe','pipe'],
    env:{...process.env,GH_TOKEN:process.env.GH_TOKEN},
  }));
}
function commitEvidence(sha) {
  const path = 'repos/' + REPO + '/commits/' + sha;
  const checks = api(path + '/check-runs?per_page=100');
  const statuses = api(path + '/statuses?per_page=100');
  if (!Array.isArray(checks.check_runs) || checks.total_count > 100 ||
      !Array.isArray(statuses) || statuses.length >= 100)
    throw Error('CHECK_INVENTORY_UNBOUNDED');
  return {checks:checks.check_runs,statuses};
}

function audit(prNumber) {
  const pr = api('repos/' + REPO + '/pulls/' + prNumber);
  if (!['main','staging'].includes(pr?.base?.ref))
    throw Error('UNSUPPORTED_PR_BASE');
  const branch = api('repos/' + REPO + '/branches/' + pr.base.ref);
  // This is the effective ruleset readback, not merely workflow display names.
  // 403/404 is Pending, never an inferred absence of rules.
  const rules = api('repos/' + REPO + '/rules/branches/' + pr.base.ref + '?per_page=100');
  const mergeCommit = api('repos/' + REPO + '/git/commits/' + pr.merge_commit_sha);
  const snapshot = {pr,branch,rules,mergeCommit,
    headEvidence:commitEvidence(pr.head.sha),
    mergeEvidence:commitEvidence(pr.merge_commit_sha)};
  // Re-read mutable identities after the inventory; stale observations cannot
  // certify a later HEAD or base.
  const afterPr = api('repos/' + REPO + '/pulls/' + prNumber);
  const afterBranch = api('repos/' + REPO + '/branches/' + pr.base.ref);
  if (pr.head.sha !== afterPr.head.sha ||
      pr.merge_commit_sha !== afterPr.merge_commit_sha ||
      branch.commit.sha !== afterBranch.commit.sha)
    throw Error('PR_OR_BASE_MOVED_DURING_AUDIT');
  return inspectProtectedCandidate(snapshot);
}

function selfTest() {
  const a='a'.repeat(40), b='b'.repeat(40), m='c'.repeat(40);
  const pr={state:'open',merge_commit_sha:m,
    base:{ref:'staging',sha:b,repo:{full_name:REPO}},
    head:{sha:a,repo:{full_name:REPO}}};
  const branch={protected:true,commit:{sha:b},
    protection:{required_status_checks:{enforcement_level:'everyone',
      checks:[{context:'rust-check',app_id:15368},
        {context:'web-check',app_id:15368}]}}};
  const check=(name,sha=m,app=15368,conclusion='success') =>
    ({id:9,name,head_sha:sha,app:{id:app},status:'completed',conclusion});
  const good={pr,branch,rules:[],mergeCommit:{sha:m,
    parents:[{sha:b},{sha:a}]},
    headEvidence:{checks:[check('rust-check',a),check('web-check',a)],statuses:[]},
    mergeEvidence:{checks:[check('rust-check'),check('web-check')],statuses:[]}};
  const evaluate = change => inspectProtectedCandidate({...good,...change});
  assert.equal(evaluate({}).state,'READY_FOR_GITHUB_RECHECK');
  assert.ok(evaluate({pr:{...pr,base:{...pr.base,sha:a}}})
    .problems.includes('STALE_BASE'));
  assert.ok(evaluate({mergeCommit:{sha:m,parents:[{sha:b},{sha:b}]}})
    .problems.includes('STALE_OR_UNVERIFIED_TEST_MERGE'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('web-check')],statuses:[]}})
    .problems.includes('MISSING_REQUIRED_CONTEXT:rust-check'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('rust-check',m,19),
    check('web-check')],statuses:[]}}).problems.includes('WRONG_CHECK_APP:rust-check'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('other'),check('web-check')],
    statuses:[]}}).problems.includes('MISSING_REQUIRED_CONTEXT:rust-check'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('rust-check',a),
    check('web-check')],statuses:[]}}).problems.includes('WRONG_CHECK_SHA:rust-check'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('rust-check',m,15368,'skipped'),
    check('web-check')],statuses:[]}})
    .problems.includes('SCOPED_SKIP_REQUIRES_SCOPE_PROOF:rust-check'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('web-check')],statuses:[]},
    headEvidence:good.headEvidence}).problems.includes('MISSING_REQUIRED_CONTEXT:rust-check'),
    'green HEAD must not mask missing test-merge checks');
  assert.ok(evaluate({rules:null}).problems.includes('PROTECTION_UNVERIFIED'));
  assert.ok(evaluate({rules:Array(100).fill({type:'other'})})
    .problems.includes('EFFECTIVE_RULESET_INVENTORY_UNBOUNDED'));
  assert.ok(evaluate({branch:{...branch,protection:{required_status_checks:{
    enforcement_level:'everyone',contexts:['rust-check','web-check']}}}})
    .problems.includes('CLASSIC_CHECK_APP_UNVERIFIED'));
  assert.ok(evaluate({branch:{...branch,protected:false}})
    .problems.includes('PROTECTION_UNVERIFIED'));
  assert.ok(evaluate({mergeEvidence:{checks:[check('rust-check'),check('web-check')],
    statuses:[{id:10,context:'rust-check',sha:m,state:'failure'}]}})
    .problems.includes('FAILED_STATUS:rust-check'));
  assert.ok(evaluate({branch:{...branch,protection:{required_status_checks:{
    enforcement_level:'everyone',checks:[{context:'rust-check',app_id:15368},
      {context:'web-check',app_id:15368},
      {context:'nession/convergence-qualification',app_id:15368}]}}},
    mergeEvidence:{checks:[check('rust-check'),check('web-check')],
      statuses:[{id:10,context:'nession/convergence-qualification',
        sha:m,state:'success'}]}})
    .problems.includes('STATUS_APP_PROVENANCE_UNVERIFIED:nession/convergence-qualification'));
  console.log('protected merge evidence self-test: PASS');
}

if (process.argv[1]?.endsWith('/protected-merge-audit.mjs')) {
  if (process.argv[2] === 'self-test') selfTest();
  else if (process.argv[2] === 'audit' &&
           /^[1-9][0-9]*$/.test(process.argv[3] ?? '')) {
    try {
      if (!process.env.GH_TOKEN) throw Error('MISSING_READ_TOKEN');
      const result = audit(Number(process.argv[3]));
      console.log(JSON.stringify(result,null,2));
      if (result.state !== 'READY_FOR_GITHUB_RECHECK') process.exitCode=2;
    } catch (error) {
      console.log(JSON.stringify({state:'PENDING',problems:[String(error.message)
        .replace(/\s+/g,' ').slice(0,200)]},null,2));
      process.exitCode=2;
    }
  } else throw Error('usage: protected-merge-audit.mjs self-test | audit PR_NUMBER');
}
