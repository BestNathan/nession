#!/usr/bin/env node
// #2926: deterministic, fail-closed gate for two-hour convergence merge proposals.
// The model is never allowed to issue or certify this verdict.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {parsePreMergeIssueNumbers,validateRequirementBody,isAcceptanceIssue}
  from './requirement-acceptance.mjs';
import {isNativeConvergencePr,verifiedConvergenceBatch,convergenceApproval,
  convergenceBatchDigest,latestConvergenceFull,attestConvergenceFull}
  from './staging-convergence-pr.mjs';

const SHA=/^[0-9a-f]{40}$/;
const REPO='BestNathan/nession';
const REQUIRED=[
  '.github/workflows/ci-quality.yml',
  '.github/workflows/acceptance-case-smoke.yml',
  '.github/workflows/e2e-tests.yml',
];
const DEPLOY='.github/workflows/release-staging.yml';
const fail=reason=>({ready:false,reason});
const okay=details=>({ready:true,reason:'QUALIFIED',...details});

// One authoritative exact-HEAD checks policy for initial Staging sync and
// later main promotion. A merged PR never inherits a status from its newer
// branch tip, and skipped/missing/failed source jobs cannot authorize release.
export function requiredSourceRuns(prNumber,expectedHead,workflowRuns=[]){
  if(!Number.isSafeInteger(prNumber)||prNumber<=0||!SHA.test(expectedHead)||
      !Array.isArray(workflowRuns)||workflowRuns.length>100)
    return fail('INVALID_RUN_INVENTORY');
  for(const path of REQUIRED){
    const matches=workflowRuns.filter(run=>run.path?.split('@')[0]===path &&
      run.head_sha===expectedHead&&run.event==='pull_request'&&
      run.head_repository?.full_name===REPO&&
      Array.isArray(run.pull_requests)&&
      run.pull_requests.some(p=>p.number===prNumber));
    const newest=matches.sort((a,b)=>(b.run_number??0)-(a.run_number??0)||
      (b.run_attempt??0)-(a.run_attempt??0)||(b.id??0)-(a.id??0))[0];
    if(!newest||newest.status!=='completed'||newest.conclusion!=='success')
      return fail('MISSING_EXACT_HEAD_PR_CHECK:'+path);
  }
  return okay({expectedHead});
}

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
  const checks=requiredSourceRuns(pr.number,expectedHead,workflowRuns);
  if(!checks.ready)return checks;
  return okay({expectedHead,expectedBase});
}

export function evaluatePromotion({firstParentCommits=[],associations=[],issues=[],
  authenticatedNative=[],deployRuns=[],laneSha,branch='staging',
  deployment_workflows=['release-staging.yml']}) {
  if(!SHA.test(laneSha)||!Array.isArray(firstParentCommits)||
      firstParentCommits.length===0)
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
  // History size is not an authorization rule: each unique merged commit must
  // still be independently bound to its source PR and proof below.
  const commitSet=new Set(firstParentCommits);
  if(commitSet.size!==firstParentCommits.length)
    return fail('INVALID_PR_PROVENANCE');
  if(!Array.isArray(authenticatedNative)||
     authenticatedNative.some(x=>!SHA.test(x)||!commitSet.has(x))||
     new Set(authenticatedNative).size!==authenticatedNative.length)
    return fail('INVALID_NATIVE_PROMOTION_PROOF');
  const native=new Set(authenticatedNative),referenced=new Set();
  for(let n=0;n<firstParentCommits.length;n++){
    const item=firstParentCommits[n],pairs=associations[n];
    if(!SHA.test(item)||!Array.isArray(pairs))return fail('INVALID_PR_PROVENANCE');
    const matches=pairs.filter(pr=>pr.merge_commit_sha===item&&pr.merged_at&&
      pr.base?.ref===branch&&pr.base?.repo?.full_name===REPO);
    if(matches.length!==1)return fail('MISSING_STAGING_MERGE_PR:'+item);
    const pr=matches[0];
    // Native PRs have no disposable Issue. Their digest, immutable two-parent
    // Git source, Owner approval and exact PR checks have been independently
    // re-attested in the trusted Main promoter; never trust this marker alone.
    if(isNativeConvergencePr(pr)){
      if(!native.has(item))return fail('UNATTESTED_NATIVE_STAGING_SYNC:'+item);
      if(parsePreMergeIssueNumbers(pr.body,'BestNathan','nession',pr.title).length)
        return fail('NATIVE_STAGING_SYNC_HAS_ISSUE_ASSOCIATION:'+item);
      continue;
    }
    // Ordinary feature/legacy sync Issues still require their exact source
    // acceptance. No source PR may inherit a newer unrelated Issue result.
    const numbers=parsePreMergeIssueNumbers(pr.body, 'BestNathan','nession',pr.title);
    if(numbers.length===0)return fail('UNASSOCIATED_STAGING_CHANGE:'+item);
    for(const number of numbers)referenced.add(number);
  }
  if(referenced.size===0&&native.size===0)return fail('NO_ACCEPTANCE_ISSUES');
  for(const n of referenced){
    const issue=issues.find(x=>x.number===n);
    if(!issue||!isAcceptanceIssue(issue)||issue.state_reason==='not_planned')
      return fail('MISSING_VALID_ISSUE:'+n);
    const report=validateRequirementBody(issue.body,{mode:'merge',targetBranch:'main'});
    if(!report.ok)return fail('PENDING_ISSUE_ACCEPTANCE:'+n);
  }
  return okay({issueNumbers:[...referenced].sort((a,b)=>a-b),
    nativeMergeShas:[...native].sort()});
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

// Only Main's trusted controller can supply this proof; an arbitrary PR
// marker, Issue label or model verdict is never enough to promote a native
// Staging integration. Reconstruct Git bytes, verified Full proof and
// independent exact-source PR Runs for EVERY merged sync commit.
export function certifyNativeMerge({pr,mergeSha,repoRoot=process.cwd(),
  branch='staging',sourceRuns=[],fullReceipt=null}){
  if(!isNativeConvergencePr(pr)||!SHA.test(mergeSha)||!pr?.merged_at||
     pr.merge_commit_sha!==mergeSha||pr.base?.ref!==branch||
     pr.base?.repo?.full_name!==REPO)
    return fail('INVALID_NATIVE_MERGE_PR');
  let parents;
  try {
    parents=execFileSync('git',['rev-list','--parents','-n','1',mergeSha],{
      cwd:repoRoot,encoding:'utf8',maxBuffer:4_000_000,
      stdio:['ignore','pipe','pipe'],
    }).trim().split(/\s+/);
  } catch {
    // A forged or unavailable merge commit cannot crash the evaluator or be
    // treated as a successful GitHub merge. Deny deterministically.
    return fail('NATIVE_MERGE_COMMIT_UNAVAILABLE');
  }
  if(parents.length!==3||parents[0]!==mergeSha||
     parents[2]!==pr.head?.sha)
    return fail('NATIVE_MERGE_PARENTS_MISMATCH');
  let batch;
  try{
    batch=verifiedConvergenceBatch(pr,repoRoot,parents[1],mergeSha,
      {requireCheckout:false});
  }catch(error){
    return fail('NATIVE_GIT_SOURCE_NOT_ATTESTED:'+error.message);
  }
  const approval=convergenceApproval(batch,fullReceipt);
  if(!approval.approved)return fail('NATIVE_'+approval.reason+':'+batch.integration_head);
  const source=requiredSourceRuns(pr.number,batch.integration_head,sourceRuns);
  if(!source.ready)return source;
  return okay({integrationHead:batch.integration_head,
    sourceBatchDigest:convergenceBatchDigest(batch)});
}

// Independently re-attest the complete Full E2E source before Main
// promotion. A PR marker and a prior Staging merge do not prove Full success.
function nativeFullReceipt(batch,pr){
  if(convergenceApproval(batch).approved)return null;
  const since=String(pr.created_at??'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(since))
    throw Error('native PR missing trustworthy creation fence');
  const inventory=read('actions/workflows/e2e-full-regression.yml/runs?'+
    'event=workflow_dispatch&created=>='+since+'&per_page=100');
  if(!Array.isArray(inventory.workflow_runs)||inventory.workflow_runs.length>=100)
    throw Error('unbounded native Full inventory during promotion');
  const run=latestConvergenceFull(batch,inventory.workflow_runs);
  if(!run||run.status!=='completed'||run.conclusion!=='success')return null;
  const jobs=read('actions/runs/'+run.id+'/attempts/'+
    run.run_attempt+'/jobs?per_page=100');
  if(!Array.isArray(jobs.jobs)||jobs.jobs.length>=100)
    throw Error('unbounded native Full job inventory during promotion');
  return attestConvergenceFull(batch,run,jobs.jobs);
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
  if(!preliminary.ready) {
    // #3248: the controller has observed a missing exact-head check even
    // when public GitHub REST reports that run as successful. Emit the
    // bounded authenticated inventory *fields*, not a replacement verdict.
    // The fail-closed source/run/PR matching above remains authoritative.
    if(preliminary.reason.startsWith('MISSING_EXACT_HEAD_PR_CHECK:')) {
      const candidates=runs.filter(r =>
        REQUIRED.includes(r.path?.split('@')[0]) ||
        r.head_sha===expectedHead).slice(0,20);
      console.error('staging convergence exact-head PR check diagnostic: '+
        JSON.stringify({
          reason:preliminary.reason,
          pr_number:pr.number,expected_head:expectedHead,
          run_count:runs.length,
          candidates:candidates.map(r=>({
            id:r.id,path:r.path,head_sha:r.head_sha,event:r.event,
            status:r.status,conclusion:r.conclusion,
            head_repo:r.head_repository?.full_name??null,
            associated_prs:Array.isArray(r.pull_requests)
              ?r.pull_requests.map(p=>p.number):null,
            run_number:r.run_number,run_attempt:r.run_attempt,
          })),
        }));
    }
    return preliminary;
  }
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

  // Verify the *entire* exact main..staging first-parent history, regardless
  // of commit count. A cherry-pick/direct push still lacks the required merged
  // source PR and cannot pass the provenance/Issue acceptance checks below.
  const commits=git(['rev-list','--first-parent','--reverse','origin/main..origin/'+branch])
    .split('\n').filter(Boolean);
  if(commits.length===0)return fail('EMPTY_PROMOTION');
  const associations=commits.map(sha=>read('commits/'+sha+'/pulls?per_page=100'));
  const numberSet=new Set();
  for(const group of associations){
    for(const p of group){
      for(const n of parsePreMergeIssueNumbers(p.body,'BestNathan','nession',p.title))numberSet.add(n);
    }
  }
  const issues=[...numberSet].map(n=>read('issues/'+n));
  const authenticatedNative=[];
  for(let i=0;i<commits.length;i++){
    const matches=associations[i].filter(pr=>pr.merge_commit_sha===commits[i]&&
      pr.merged_at&&pr.base?.ref===branch&&pr.base?.repo?.full_name===REPO);
    if(matches.length!==1||!isNativeConvergencePr(matches[0]))continue;
    const nativePr=matches[0];
    const runs=getRuns('head_sha='+nativePr.head.sha+'&event=pull_request');
    const sourceBatchSha=nativePr.head.sha;
    let fullReceipt=null;
    // Rebuild the pinned source *before* reading any Full Run. This reuses
    // the sole canonical Git/plan owner and rejects altered PR declarations.
    const parents=git(['rev-list','--parents','-n','1',commits[i]]).split(/\s+/);
    if(parents.length!==3||parents[2]!==sourceBatchSha)
      return fail('NATIVE_MERGE_PARENTS_MISMATCH');
    let batch;
    try{batch=verifiedConvergenceBatch(nativePr,process.cwd(),
      parents[1],commits[i],{requireCheckout:false});}
    catch(error){return fail('NATIVE_GIT_SOURCE_NOT_ATTESTED:'+error.message);}
    fullReceipt=nativeFullReceipt(batch,nativePr);
    const proof=certifyNativeMerge({pr:nativePr,mergeSha:commits[i],
      branch,sourceRuns:runs,fullReceipt});
    if(!proof.ready)return proof;
    authenticatedNative.push(commits[i]);
  }
  const deployRuns=deployment_workflows.flatMap(file=>getRuns('actions/workflows/'+encodeURIComponent(file)+'/runs?head_sha='+laneSha));
  return evaluatePromotion({firstParentCommits:commits,associations,issues,
    authenticatedNative,deployRuns,laneSha,branch,deployment_workflows});
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
  // A staging sync branch and model-copyable PR body do not attest Issue
  // acceptance. With a valid deployment Run, missing source Issues must
  // still block *before* main promotion, even if the PR is bot-shaped.
  const deployed={path:DEPLOY,head_sha:b,head_branch:'staging',event:'push',
    status:'completed',conclusion:'success',run_number:10,run_attempt:1,
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const forged={merge_commit_sha:a,merged_at:'2026-11-10T00:00:00Z',
    base:{ref:'staging',repo:{full_name:REPO}},
    head:{ref:'chore/staging-sync-staging-aaaaaaaaaaaa-bbbbbbbbbbbb',
      repo:{full_name:REPO}},
    body:'Staging Convergence automated proposal (source: copied)',title:'auto sync'};
  assert.equal(evaluatePromotion({firstParentCommits:[a],associations:[[forged]],
    issues:[],deployRuns:[deployed],laneSha:b}).reason,'UNASSOCIATED_STAGING_CHANGE:'+a);
  assert.equal(evaluatePromotion({firstParentCommits:[a],
    associations:[[{...forged,body:forged.body+'\n\nRefs #123'}]],
    issues:[{number:123,labels:[{name:'requirement'}],body:'Pending'}],
    deployRuns:[deployed],laneSha:b}).reason,'PENDING_ISSUE_ACCEPTANCE:123');
  // Native generated PRs have no disposable Issue, but a marker cannot
  // provide its own authorization. Only a complete separately certified
  // immutable Git/Owner/CI proof may satisfy main promotion.
  const native={...forged,body:forged.body+
    '\n\n<!-- nession-convergence-pr:v1 source=fake -->'};
  assert.equal(evaluatePromotion({firstParentCommits:[a],
    associations:[[native]],issues:[],deployRuns:[deployed],laneSha:b}).reason,
    'UNATTESTED_NATIVE_STAGING_SYNC:'+a);
  const proven=evaluatePromotion({firstParentCommits:[a],
    associations:[[native]],issues:[],authenticatedNative:[a],
    deployRuns:[deployed],laneSha:b});
  assert.equal(proven.ready,true,'authenticated native source needs no fake Issue');
  assert.deepEqual(proven.issueNumbers,[]);
  assert.deepEqual(proven.nativeMergeShas,[a]);
  // Development velocity is not an authorization boundary. A history with
  // >90 source-bound merges must pass, while one missing proof or provenance
  // record must still prevent promotion.
  const longHistory=Array.from({length:128},(_,i)=>
    (i+1).toString(16).padStart(40,'0'));
  const longAssociations=longHistory.map(merge_commit_sha=>
    [{...native,merge_commit_sha}]);
  const largePromotion={firstParentCommits:longHistory,
    associations:longAssociations,issues:[],
    authenticatedNative:longHistory,deployRuns:[deployed],laneSha:b};
  assert.equal(evaluatePromotion(largePromotion).ready,true,
    'large fully attested staging history is eligible without a count threshold');
  assert.equal(evaluatePromotion({...largePromotion,
    authenticatedNative:longHistory.slice(0,-1)}).reason,
    'UNATTESTED_NATIVE_STAGING_SYNC:'+longHistory.at(-1),
    'missing native source proof must remain a blocker in large histories');
  assert.equal(evaluatePromotion({...largePromotion,
    associations:longAssociations.slice(0,-1)}).reason,'INCOMPLETE_PR_PROVENANCE',
    'partial PR inventory must remain a blocker in large histories');
  assert.equal(evaluatePromotion({...largePromotion,
    firstParentCommits:[...longHistory,longHistory.at(-1)]}).reason,
    'INVALID_PR_PROVENANCE',
    'duplicate commit identities cannot be used to inflate authenticated history');
  assert.equal(evaluatePromotion({firstParentCommits:[a],
    associations:[[native]],issues:[],authenticatedNative:[b],
    deployRuns:[deployed],laneSha:b}).reason,'INVALID_NATIVE_PROMOTION_PROOF');
  assert.equal(evaluatePromotion({firstParentCommits:[a],
    associations:[[{...native,body:native.body+'\nRefs #123'}]],issues:[],
    authenticatedNative:[a],deployRuns:[deployed],laneSha:b}).reason,
    'NATIVE_STAGING_SYNC_HAS_ISSUE_ASSOCIATION:'+a);
  assert.equal(certifyNativeMerge({pr:native,mergeSha:a}).reason,
    'NATIVE_MERGE_COMMIT_UNAVAILABLE',
    'an unavailable forged PR merge SHA must fail closed, not crash or pass');
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
