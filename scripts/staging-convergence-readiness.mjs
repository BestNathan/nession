#!/usr/bin/env node
// #2926: deterministic, fail-closed gate for two-hour convergence merge proposals.
// The model is never allowed to issue or certify this verdict.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parsePreMergeIssueNumbers,validateRequirementBody,isAcceptanceIssue}
  from './requirement-acceptance.mjs';

const SHA=/^[0-9a-f]{40}$/;
const REPO='BestNathan/nession';
const REQUIRED=[
  '.github/workflows/ci-quality.yml',
  '.github/workflows/acceptance-case-smoke.yml',
  '.github/workflows/e2e-tests.yml',
];
const DEPLOY='.github/workflows/release-staging.yml';
const PROMOTION_LIMIT=90;
const fail=reason=>({ready:false,reason});
const okay=details=>({ready:true,reason:'QUALIFIED',...details});

export function evaluatePull({pr,action,plan,baseSha,workflowRuns=[]}) {
  const branch=action==='sync-main-to-lane'?plan.branch:'main';
  const head=action==='sync-main-to-lane'?plan.sync_ref:plan.branch;
  if(!pr || !['sync-main-to-lane','promote-lane-to-main'].includes(action) ||
      !SHA.test(plan.main_sha)||!SHA.test(plan.sha)||
      (action==='sync-main-to-lane' &&
        (!SHA.test(plan.sync_head_sha)||!/^chore\/staging-sync-[a-zA-Z0-9-]+$/.test(plan.sync_ref??''))))
    return fail('INVALID_INPUT');
  if(pr.state!=='open'||pr.draft||!pr.body?.startsWith('Staging Convergence automated proposal')||
      pr.base?.ref!==branch||pr.head?.ref!==head ||
      pr.head?.repo?.full_name!==REPO)return fail('UNTRUSTED_PR_IDENTITY');
  const expectedHead=action==='sync-main-to-lane'?plan.sync_head_sha:plan.sha;
  const expectedBase=action==='sync-main-to-lane'?plan.sha:plan.main_sha;
  if(pr.head.sha!==expectedHead||pr.base.sha!==expectedBase||baseSha!==expectedBase)
    return fail('STALE_PR_SHA');
  if(pr.mergeable_state==='dirty' && pr.mergeable===false)
    return fail('MERGE_CONFLICT');
  // Protected staging requires rust-check/web-check on the *integration*
  // head. A direct main -> staging PR can be "behind" with all source checks
  // green yet be rejected by GitHub (HTTP 405, required statuses expected).
  // The checked integration branch contains staging + main ancestry and must
  // become genuinely clean. Never waive required checks for a behind PR.
  if(pr.mergeable!==true||pr.mergeable_state!=='clean')
    return fail('PR_NOT_CLEAN_OR_REQUIRED_CHECKS_PENDING');
  if(!Array.isArray(workflowRuns)||workflowRuns.length>100)
    return fail('INVALID_RUN_INVENTORY');
  for(const path of REQUIRED){
    const matches=workflowRuns.filter(run=>run.path?.split('@')[0]===path &&
      run.head_sha===expectedHead && run.event==='pull_request' &&
      run.head_repository?.full_name===REPO &&
      Array.isArray(run.pull_requests) &&
      run.pull_requests.some(p=>p.number===pr.number));
    // A failed older attempt must not poison a later authenticated successful
    // rerun at the *same* target SHA. Only the newest real workflow attempt
    // determines readiness; an in-progress newer run blocks an older green.
    const newest=matches.sort((a,b)=>(b.run_number??0)-(a.run_number??0)||
      (b.run_attempt??0)-(a.run_attempt??0)||(b.id??0)-(a.id??0))[0];
    if(!newest||newest.status!=='completed'||newest.conclusion!=='success')
      return fail('MISSING_EXACT_HEAD_PR_CHECK:'+path);
  }
  return okay({expectedHead,expectedBase});
}

export function evaluatePromotion({firstParentCommits=[],associations=[],issues=[],deployRuns=[],laneSha,branch='staging',deployment_workflows=['release-staging.yml']}) {
  if(!SHA.test(laneSha)||!Array.isArray(firstParentCommits)||
      firstParentCommits.length===0||firstParentCommits.length>PROMOTION_LIMIT)
    return fail('UNBOUNDED_OR_EMPTY_PROMOTION');
  const run=deployRuns.filter(r=>deployment_workflows.some(file=>r.path?.split('@')[0]==='.github/workflows/'+file) &&
    r.head_sha===laneSha && r.head_branch===branch && r.event==='push' &&
    r.repository?.full_name===REPO && r.head_repository?.full_name===REPO);
  // GitHub run inventories are not a stable ordering guarantee; an older
  // success must not mask a later failed/in-progress deployment attempt.
  const latest=[...run].sort((a,b)=>(b.run_number??0)-(a.run_number??0)||
    (b.run_attempt??0)-(a.run_attempt??0)||(b.id??0)-(a.id??0))[0];
  if(!latest||latest.status!=='completed'||latest.conclusion!=='success')
    return fail('STAGING_RELEASE_NOT_PROVEN');
  if(!Array.isArray(associations)||associations.length!==firstParentCommits.length)
    return fail('INCOMPLETE_PR_PROVENANCE');
  const referenced=new Set();
  for(let n=0;n<firstParentCommits.length;n++){
    const item=firstParentCommits[n],pairs=associations[n];
    if(!SHA.test(item)||!Array.isArray(pairs))return fail('INVALID_PR_PROVENANCE');
    const matches=pairs.filter(pr=>pr.merge_commit_sha===item&&pr.merged_at&&
      pr.base?.ref===branch&&pr.base?.repo?.full_name===REPO);
    if(matches.length!==1)return fail('MISSING_STAGING_MERGE_PR:'+item);
    const pr=matches[0];
    // Trusted main->staging sync PRs introduce no new acceptance obligations.
    if(pr.head?.ref?.startsWith('chore/staging-sync-') &&
      pr.head?.repo?.full_name===REPO &&
      pr.body?.startsWith('Staging Convergence automated proposal'))continue;
    const numbers=parsePreMergeIssueNumbers(pr.body, 'BestNathan','nession',pr.title);
    if(numbers.length===0)return fail('UNASSOCIATED_STAGING_CHANGE:'+item);
    for(const number of numbers)referenced.add(number);
  }
  if(referenced.size===0)return fail('NO_ACCEPTANCE_ISSUES');
  for(const n of referenced){
    const issue=issues.find(x=>x.number===n);
    if(!issue||!isAcceptanceIssue(issue)||issue.state_reason==='not_planned')
      return fail('MISSING_VALID_ISSUE:'+n);
    const report=validateRequirementBody(issue.body,{mode:'merge',targetBranch:'main'});
    if(!report.ok)return fail('PENDING_ISSUE_ACCEPTANCE:'+n);
  }
  return okay({issueNumbers:[...referenced].sort((a,b)=>a-b)});
}

function read(route){
  const token=process.env.READ_GITHUB_TOKEN;
  if(!token)throw new Error('READ_GITHUB_TOKEN is required');
  return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+route],
    {encoding:'utf8',env:{...process.env,GH_TOKEN:token},maxBuffer:4_000_000}));
}
// Never nest a workflow-runs endpoint inside the repository-wide runs query.
// The latter silently lost exact-SHA staging deployment proof during promotion.
export function workflowRunsRoute(route){
  if(typeof route!=='string'||!(
    /^head_sha=[a-f0-9]{40}&event=pull_request$/.test(route)||
    /^actions\/workflows\/[A-Za-z0-9._-]+\.ya?ml\/runs\?head_sha=[a-f0-9]{40}$/.test(route)
  ))throw Error('invalid bounded workflow run route');
  return (route.startsWith('actions/workflows/')?route:'actions/runs?'+route)+
    '&per_page=100';
}
function getRuns(route){
  const result=read(workflowRunsRoute(route));
  if(!Array.isArray(result.workflow_runs)||result.total_count>100)
    throw new Error('unbounded workflow run inventory');
  return result.workflow_runs;
}
function git(args){
  return execFileSync('git',args,{encoding:'utf8',maxBuffer:4_000_000}).trim();
}

export function qualify({action,prNumber,mainSha,laneSha,branch,
    syncRef=null,syncHeadSha=null,deployment_workflows=[]}) {
  if(!Number.isSafeInteger(prNumber)||prNumber<=0||!SHA.test(mainSha)||
     !SHA.test(laneSha)||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)||branch==='main'||
     (action==='promote-lane-to-main'&&!deployment_workflows.length))throw new Error('invalid exact convergence target');
  const pr=read('pulls/'+prNumber);
  const baseRef=action==='sync-main-to-lane'?branch:'main';
  const baseSha=git(['ls-remote','origin','refs/heads/'+baseRef]).split(/\s+/)[0];
  const expectedHead=action==='sync-main-to-lane'?syncHeadSha:laneSha;
  const runs=getRuns('head_sha='+expectedHead+'&event=pull_request');
  const preliminary=evaluatePull({pr,action,plan:{branch,main_sha:mainSha,sha:laneSha,
    sync_ref:syncRef,sync_head_sha:syncHeadSha},baseSha,workflowRuns:runs});
  if(!preliminary.ready)return preliminary;
  if(action==='sync-main-to-lane')return preliminary;

  // A code-promotion merge must not silently become a Production release.
  // Production's current version-tag retry path can publish even without a bump
  // if its tag is absent. Keep the explicit release/version owner separate.
  const versionOf=(ref,path)=> {
    const text=git(['show','origin/'+ref+':'+path]);
    const match=path==='Cargo.toml'
      ? /^version\s*=\s*"([^"]+)"/m.exec(text)
      : /"version"\s*:\s*"([^"]+)"/.exec(text);
    if(!match)throw Error('missing release version in '+ref+':'+path);
    return match[1];
  };
  const mainRust=versionOf('main','Cargo.toml');
  const mainWeb=versionOf('main','web/package.json');
  if(mainRust!==mainWeb ||
     versionOf(branch,'Cargo.toml')!==mainRust ||
     versionOf(branch,'web/package.json')!==mainWeb) {
    return fail('VERSION_CHANGE_REQUIRES_SEPARATE_RELEASE_PR');
  }
  const tag=git(['ls-remote','--tags','--refs','origin','refs/tags/v'+mainRust]);
  if(!tag||!SHA.test(tag.split(/\s+/)[0]))return fail('CURRENT_RELEASE_TAG_NOT_FOUND');

  // First-parent integration history is bounded. No cherry-pick/direct-push
  // change is eligible without a normal source PR/Issue acceptance.
  const commits=git(['rev-list','--first-parent','--reverse','origin/main..origin/'+branch])
    .split('\n').filter(Boolean);
  if(commits.length===0||commits.length>PROMOTION_LIMIT)return fail('UNBOUNDED_PROMOTION');
  const associations=commits.map(sha=>read('commits/'+sha+'/pulls?per_page=100'));
  const numberSet=new Set();
  for(const group of associations){
    for(const p of group){
      for(const n of parsePreMergeIssueNumbers(p.body,'BestNathan','nession',p.title))numberSet.add(n);
    }
  }
  const issues=[...numberSet].map(n=>read('issues/'+n));
  const deployRuns=deployment_workflows.flatMap(file=>getRuns('actions/workflows/'+encodeURIComponent(file)+'/runs?head_sha='+laneSha));
  return evaluatePromotion({firstParentCommits:commits,associations,issues,deployRuns,laneSha,branch,deployment_workflows});
}

function selfTest(){
  const a='a'.repeat(40),b='b'.repeat(40);
  const syncHead='c'.repeat(40),syncRef='chore/staging-sync-aaaaaaaaaaaa-bbbbbbbbbbbb';
  const plan={branch:'staging',main_sha:a,sha:b,sync_ref:syncRef,sync_head_sha:syncHead};
  const pr={number:88,state:'open',draft:false,body:'Staging Convergence automated proposal (test)',mergeable:true,mergeable_state:'clean',
    base:{ref:'staging',sha:b},head:{ref:syncRef,sha:syncHead,repo:{full_name:REPO}}};
  const runs=REQUIRED.map((path,n)=>({id:n+1,path,head_sha:syncHead,event:'pull_request',
    status:'completed',conclusion:'success',run_number:n+1,run_attempt:1,
    head_repository:{full_name:REPO},pull_requests:[{number:88}]}));
  assert.equal(evaluatePull({pr,action:'sync-main-to-lane',plan,baseSha:b,workflowRuns:runs}).ready,true);
  assert.equal(evaluatePull({pr:{...pr,mergeable_state:'behind'},action:'sync-main-to-lane',
    plan,baseSha:b,workflowRuns:runs}).ready,false,
    'behind source PR must not bypass protected staging merge-commit checks');
  assert.equal(evaluatePull({pr:{...pr,mergeable:false,mergeable_state:'behind'},
    action:'sync-main-to-lane',plan,baseSha:b,workflowRuns:runs}).ready,false,
    'behind does not override a GitHub-negative mergeability verdict');
  for (const state of ['unknown','blocked','dirty','unstable']) {
    assert.equal(evaluatePull({pr:{...pr,mergeable_state:state},
      action:'sync-main-to-lane',plan,baseSha:b,workflowRuns:runs}).ready,false,
      'GitHub blocked/unknown state must fail closed: '+state);
  }
  const promo={...pr,base:{ref:'main',sha:a},head:{ref:'staging',sha:b,repo:{full_name:REPO}}};
  assert.equal(evaluatePull({pr:{...promo,mergeable_state:'behind'},action:'promote-lane-to-main',
    plan,baseSha:a,workflowRuns:runs}).ready,false,
    'promotion is not eligible merely because its branch is behind');

  assert.match(evaluatePull({pr:{...pr,draft:true},action:'sync-main-to-lane',
    plan,baseSha:b,workflowRuns:runs}).reason,/UNTRUSTED/);
  assert.match(evaluatePull({pr,action:'sync-main-to-lane',
    plan,baseSha:a,workflowRuns:runs}).reason,/STALE/);
  assert.equal(evaluatePull({pr:{...pr,mergeable:false,mergeable_state:'dirty'},
    action:'sync-main-to-lane',plan,baseSha:b,workflowRuns:runs}).reason,'MERGE_CONFLICT');
  assert.match(evaluatePull({pr,action:'sync-main-to-lane',
    plan,baseSha:b,workflowRuns:runs.slice(1)}).reason,/MISSING/);
  assert.match(evaluatePull({pr,action:'sync-main-to-lane',plan,baseSha:b,
    workflowRuns:runs.map(r=>({...r,conclusion:'failure'}))}).reason,/MISSING/);
  const obsolete={...runs[0],id:98,run_number:0,conclusion:'failure'};
  const latest={...runs[0],id:99,run_number:100,conclusion:'success'};
  assert.equal(evaluatePull({pr,action:'sync-main-to-lane',plan,baseSha:b,
    workflowRuns:[obsolete,latest,...runs.slice(1)]}).ready,true,
    'old red check must not poison newer exact-HEAD green');
  assert.match(evaluatePull({pr,action:'sync-main-to-lane',plan,baseSha:b,
    workflowRuns:[latest,{...latest,id:100,run_number:101,status:'in_progress',conclusion:null},...runs.slice(1)]}).reason,/MISSING/,
    'newer pending workflow must block stale green');
  assert.match(evaluatePull({pr,action:'sync-main-to-lane',plan,baseSha:b,
    workflowRuns:[latest,{...latest,id:101,run_number:101,conclusion:'failure'},...runs.slice(1)]}).reason,/MISSING/,
    'newer failed check must override historical green');
  assert.equal(evaluatePromotion({firstParentCommits:[a],associations:[],
    issues:[],deployRuns:[],laneSha:b}).ready,false);
  assert.equal(workflowRunsRoute('head_sha='+a+'&event=pull_request'),
    'actions/runs?head_sha='+a+'&event=pull_request&per_page=100');
  assert.equal(workflowRunsRoute('actions/workflows/release-staging.yml/runs?head_sha='+b),
    'actions/workflows/release-staging.yml/runs?head_sha='+b+'&per_page=100');
  assert.throws(()=>workflowRunsRoute('actions/runs?actions/workflows/x.yml/runs?head_sha='+b),
    /invalid bounded workflow run route/);
  assert.throws(()=>workflowRunsRoute('actions/workflows/../runs?head_sha='+b),
    /invalid bounded workflow run route/);
  console.log('staging convergence readiness self-test: PASS');
}
if(process.argv[1]?.endsWith('/staging-convergence-readiness.mjs')){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='qualify'){
    const [action,num,mainSha,laneSha,branch,deployList='',syncRef='',syncHeadSha='']=process.argv.slice(3);
    console.log(JSON.stringify(qualify({action,prNumber:Number(num),mainSha,laneSha,branch,
      syncRef:syncRef||null,syncHeadSha:syncHeadSha||null,
      deployment_workflows:deployList.split(',').filter(Boolean)})));
  }else throw Error('usage: self-test | qualify <action> <pr> <main-sha> <lane-sha> <branch> [deploy-workflows] [sync-ref] [sync-head-sha]');
}
