#!/usr/bin/env node
// PR-native, source-bound Staging integration contract. A GitHub PR is the
// batch; ordinary feature Issues remain independent. No per-sync Issue writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {planBatch} from './staging-convergence-batch.mjs';
import {catalogFromPaths,planDigest} from './issue-e2e-plan.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const MARKER='nession-convergence-pr:v1';
const sha256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{
  cwd:root,encoding:'utf8',maxBuffer:8_000_000,
  stdio:['ignore','pipe','pipe'],
}).trim();
const ancestors=(root,a,b)=>{
  try{git(root,'merge-base','--is-ancestor',a,b);return true;}
  catch(error){if(error.status===1)return false;throw error;}
};
const safeBranch=name=>typeof name==='string'&&
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(name)&&
  name!=='main'&&!name.includes('..')&&!name.includes('@{')&&
  !name.endsWith('.lock');
function integrationBranch(branch,main,lane){
  return 'chore/staging-sync-'+branch.replace(/[\/._]/g,'-')+
    '-'+main.slice(0,12)+'-'+lane.slice(0,12);
}

// This digest binds all historical source risk, not merely the final tree.
export function convergenceBatchDigest(batch){
  if(!safeBranch(batch?.branch)||![batch?.main_sha,batch?.lane_sha,
    batch?.integration_head].every(x=>SHA.test(x??''))||
    !Array.isArray(batch.changedPaths)||!batch.changedPaths.length||
    !['tooling-only','e2e-runner','app-runtime','e2e-fixture-catalog','mixed','unknown']
      .includes(batch.impact?.category)||
    !['newIds','regressionIds','removed'].every(k=>Array.isArray(batch[k])))
    throw Error('invalid source-bound convergence digest input');
  return sha256({
    version:1,branch:batch.branch,main:batch.main_sha,lane:batch.lane_sha,
    head:batch.integration_head,risk:batch.impact.category,
    paths:batch.changedPaths,new:batch.newIds,regression:batch.regressionIds,
    removed:batch.removed,
  });
}
export function convergencePrMarker(batch){
  return '<!-- '+MARKER+' branch='+batch.branch+' main='+batch.main_sha+
    ' lane='+batch.lane_sha+' head='+batch.integration_head+
    ' digest='+convergenceBatchDigest(batch)+' -->';
}
// #3211: promotion is a separate PR-native batch. Its exact source
// identity comes from GitHub's bot-authored PR, pinned main/lane declarations
// and current Git ancestry; a title or human-authored body alone is insufficient.
export function isNativePromotionPr(pr){
  if(pr?.title!=='release: promote staging to main' ||
      pr.user?.login!=='nession-publisher[bot]' ||
      pr.base?.ref!=='main'||pr.head?.ref!=='staging'||
      pr.base?.repo?.full_name!==REPO||pr.head?.repo?.full_name!==REPO||
      !SHA.test(pr.base?.sha??'')||!SHA.test(pr.head?.sha??'')||
      typeof pr.body!=='string'||
      !pr.body.startsWith('Staging Convergence automated proposal (source: Release / Staging Convergence).'))
    return false;
  const source=pr.body.match(/^- Planned main SHA: ([a-f0-9]{40})$/gm);
  const lane=pr.body.match(/^- Planned lane SHA: ([a-f0-9]{40})$/gm);
  if(source?.length!==1||lane?.length!==1)return false;
  // Both protected refs may advance after the bot opened this PR. The
  // original Main/Lane SHAs are immutable provenance floors; their ancestry,
  // the current exact PR refs and every test are independently reverified.
  return pr.body.includes('- Direction: staging -> main');
}

// A promotion has no disposable Requirement Issue. Select only E2E IDs
// actually modified in the exact main..staging delta. Unchanged Browser Design
// IDs are not a universal merge gate; periodic Main Full covers regression
// discovery independently (#3465). Deleted runnable tests remain fail-closed.
export function promotionE2ESelection(pr,repoRoot,baseSha,targetSha=pr?.head?.sha){
  const originallyPinnedMain=pr?.body?.match(/^- Planned main SHA: ([a-f0-9]{40})$/m)?.[1];
  const originallyPinnedLane=pr?.body?.match(/^- Planned lane SHA: ([a-f0-9]{40})$/m)?.[1];
  if(!isNativePromotionPr(pr)||baseSha!==pr.base.sha||
      targetSha!==pr.head.sha||git(repoRoot,'rev-parse','HEAD')!==targetSha||
      !ancestors(repoRoot,baseSha,targetSha)||baseSha===targetSha||
      !ancestors(repoRoot,originallyPinnedMain,baseSha)||
      !ancestors(repoRoot,originallyPinnedLane,targetSha))
    throw Error('untrusted or stale Staging promotion E2E source');
  const deleted=git(repoRoot,'diff','--name-only','--diff-filter=D',
    baseSha,targetSha,'--','e2e/tests').split('\n').filter(Boolean);
  if(deleted.some(file=>/\.spec\.ts$/.test(file)))
    throw Error('removed runnable E2E IDs require source repair before promotion');
  const touched=git(repoRoot,'diff','--name-only','--diff-filter=AMRC',
    baseSha,targetSha,'--','e2e/tests').split('\n').filter(Boolean);
  const current=git(repoRoot,'ls-tree','-r','--name-only',targetSha,'--','e2e/tests')
    .split('\n').filter(Boolean);
  const liveIds=new Set(catalogFromPaths(current));
  const ids=[...new Set(catalogFromPaths(touched))].sort();
  if(ids.some(id=>!liveIds.has(id)))
    throw Error('promotion touched E2E ID absent from exact target');
  const identity={
    type:'promotion',source_head_sha:targetSha,main_sha:baseSha,
    lane_sha:targetSha,risk:'staging-to-main',
    selection_digest:sha256({baseSha,targetSha,ids}),
  };
  return promotionE2EPlan({baseSha,targetSha,ids,convergence:identity});
}

/**
 * The convergence E2E plan (`#3311`).
 *
 * `convergence` is provenance — it identifies the immutable batch but is not
 * part of the declared obligation set — so the digest comes from
 * `planDigest`, never from hashing the whole wrapper.
 */
export function convergenceE2EPlan({baseSha,targetSha,ids,convergence}) {
  const plan={schema_version:1,kind:'issue_e2e_selection',
    base_sha:baseSha,target_sha:targetSha,issues:[],
    selected:ids.map(id=>({id,owners:[]})),
    mode:ids.length?'selected':'not-required',
    convergence};
  return {...plan,plan_digest:planDigest(plan)};
}

/** The promotion E2E plan (`#3311`); same canonical digest rule. */
export function promotionE2EPlan({baseSha,targetSha,ids,convergence}) {
  const plan={schema_version:1,kind:'issue_e2e_selection',
    base_sha:baseSha,target_sha:targetSha,issues:[],
    selected:ids.map(id=>({id,owners:[]})),
    mode:ids.length?'selected':'not-required',
    convergence};
  return {...plan,plan_digest:planDigest(plan)};
}

export function isNativeConvergencePr(pr){
  return typeof pr?.body==='string'&&
    pr.body.startsWith('Staging Convergence automated proposal')&&
    pr.body.includes('<!-- '+MARKER+' ');
}
function parseMarker(body){
  const matches=String(body??'').split(/\r?\n/)
    .filter(line=>line.startsWith('<!-- '+MARKER+' '));
  if(matches.length!==1)throw Error('missing/duplicated native convergence marker');
  const m=/^<!-- nession-convergence-pr:v1 branch=([A-Za-z0-9._/-]+) main=([a-f0-9]{40}) lane=([a-f0-9]{40}) head=([a-f0-9]{40}) digest=([a-f0-9]{64}) -->$/
    .exec(matches[0]);
  if(!m||!safeBranch(m[1]))throw Error('invalid native convergence marker');
  return {branch:m[1],main:m[2],lane:m[3],head:m[4],digest:m[5]};
}
// Rebuild the batch from immutable Git bytes and authenticate the PR metadata.
// For a merged staging push, targetSha is the merge commit and its second
// parent must be the PR integration head. No Issue is consulted or created.
export function verifiedConvergenceBatch(pr,repoRoot,baseSha,
  targetSha=pr?.head?.sha,{requireCheckout=true}={}){
  if(!isNativeConvergencePr(pr)||pr.head?.repo?.full_name!==REPO||
    pr.base?.repo?.full_name!==REPO||!safeBranch(pr.base?.ref)||
    !SHA.test(baseSha??'')||!SHA.test(targetSha??'')||
    !SHA.test(pr.head?.sha??''))
    throw Error('invalid native convergence PR/source identity');
  const marker=parseMarker(pr.body);
  if(marker.branch!==pr.base.ref||marker.lane!==baseSha||
    marker.head!==pr.head.sha||pr.head.ref!==integrationBranch(
      marker.branch,marker.main,marker.lane))
    throw Error('native convergence PR metadata does not match exact source');
  if(requireCheckout&&git(repoRoot,'rev-parse','HEAD')!==targetSha)
    throw Error('native convergence checked source differs from target SHA');
  const parents=git(repoRoot,'rev-list','--parents','-n','1',marker.head).split(/\s+/);
  if(parents.length!==3||parents[0]!==marker.head||
    parents[1]!==baseSha||parents[2]!==marker.main)
    throw Error('native convergence integration has wrong parents');
  if(!ancestors(repoRoot,marker.main,'refs/remotes/origin/main'))
    throw Error('native convergence main parent lost trusted ancestry');
  const tree=git(repoRoot,'merge-tree','--write-tree',marker.lane,marker.main)
    .split(/\s+/)[0];
  if(!SHA.test(tree)||tree!==git(repoRoot,'rev-parse',marker.head+'^{tree}'))
    throw Error('native convergence integration tree differs from trusted merge-tree');
  if(targetSha===marker.head){
    if(pr.base?.sha!==baseSha)
      throw Error('native convergence PR base advanced after exact-head selection');
  }else{
    const merged=git(repoRoot,'rev-list','--parents','-n','1',targetSha).split(/\s+/);
    if(merged.length!==3||merged[0]!==targetSha||
      merged[1]!==baseSha||merged[2]!==marker.head)
      throw Error('native convergence push does not merge exact PR head');
  }
  const batch=planBatch({branch:marker.branch,main_sha:marker.main,
    lane_sha:marker.lane,integration_head:marker.head,repoRoot});
  if(convergenceBatchDigest(batch)!==marker.digest)
    throw Error('native convergence batch digest differs from Git history');
  return batch;
}
export function convergenceE2ESelection(pr,repoRoot,baseSha,targetSha=pr?.head?.sha){
  const batch=verifiedConvergenceBatch(pr,repoRoot,baseSha,targetSha);
  const ids=[...new Set([...batch.newIds,...batch.regressionIds])].sort();
  return convergenceE2EPlan({baseSha,targetSha,ids,convergence:{
    source_head_sha:batch.integration_head,main_sha:batch.main_sha,
    lane_sha:batch.lane_sha,batch_digest:convergenceBatchDigest(batch),
    risk:batch.impact.category,
  }});
}
export function convergenceApprovalCommand(batch){
  return '/approve-staging-convergence '+batch.integration_head+' '+
    convergenceBatchDigest(batch);
}
// Historical Full receipts may still be inspected for diagnostics, but Full is
// never authorization for merging either convergence direction (#3465).
// Exact-head scoped PR checks and authentic source ancestry own admission.
export function fullRegressionTitle(batch){
  convergenceBatchDigest(batch); // validate immutable source/plan identity
  return 'Convergence Full '+integrationBranch(batch.branch,
    batch.main_sha,batch.lane_sha)+'@'+batch.integration_head;
}
// GitHub REST Workflow Runs may expose the workflow's dynamic run-name in
// both `name` and `display_title` (as observed for #3176), rather than the
// static YAML `name:`. Keep the exact batch title + workflow path/source
// checks below: a matching human-readable name alone is never evidence.
function matchingFullRunName(run,title){
  return run.name===title||run.name==='E2E / Full Regression';
}
export function latestConvergenceFull(batch,runs=[]){
  if(!Array.isArray(runs)||runs.length>=100)
    throw Error('unbounded exact-source Full E2E run inventory');
  const title=fullRegressionTitle(batch);
  return runs.filter(run=>run.display_title===title&&
    matchingFullRunName(run,title)&&
    run.event==='workflow_dispatch'&&run.head_branch==='main'&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.path?.split('@')[0]==='.github/workflows/e2e-full-regression.yml')
    .sort((a,b)=>(b.run_number??0)-(a.run_number??0)||
      (b.run_attempt??0)-(a.run_attempt??0)||(b.id??0)-(a.id??0))[0]??null;
}

export function attestConvergenceFull(batch,run,jobs=[]){
  const title=fullRegressionTitle(batch);
  if(!run||!matchingFullRunName(run,title)||
    run.path?.split('@')[0]!=='.github/workflows/e2e-full-regression.yml'||
    run.display_title!==title||run.event!=='workflow_dispatch'||
    run.head_branch!=='main'||run.repository?.full_name!==REPO||
    run.head_repository?.full_name!==REPO||
    run.status!=='completed'||run.conclusion!=='success'||
    !Number.isSafeInteger(run.id)||run.id<=0||
    !Number.isSafeInteger(run.run_attempt)||run.run_attempt<=0||
    !Array.isArray(jobs)||jobs.length>100)return null;
  const full=jobs.filter(j=>j.name==='full'&&
    j.run_id===run.id&&
    (j.run_attempt==null||j.run_attempt===run.run_attempt));
  if(full.length!==1||full[0].status!=='completed'||
      full[0].conclusion!=='success')return null;
  const completed=new Set((full[0].steps??[])
    .filter(step=>step.status==='completed'&&step.conclusion==='success')
    .map(step=>step.name));
  for(const step of ['Resolve immutable branch/SHA target',
      'Run full canonical Playwright suite at pinned SHA',
      'Verify complete per-ID assertions']){
    if(!completed.has(step))return null;
  }
  return {verified:true,source_head_sha:batch.integration_head,
    batch_digest:convergenceBatchDigest(batch),
    run_id:run.id,run_attempt:run.run_attempt};
}
export function convergenceApproval(batch){
  convergenceBatchDigest(batch); // authenticate full immutable source scope
  if(batch.impact.category==='unknown')
    return {approved:false,reason:'UNCLASSIFIED_BATCH_SCOPE'};
  if(batch.removed.length>0)
    return {approved:false,reason:'REMOVED_E2E_TESTS_REQUIRE_SOURCE_REPAIR'};
  // Applicable Quality/Case/selected E2E and GitHub mergeability are verified
  // separately by the trusted readiness owner, never inferred from this policy.
  return {approved:true,reason:'AUTOMATED_SCOPED_SOURCE_POLICY'};
}
export function selfTest(){
  const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
  const batch={branch:'staging',main_sha:a,lane_sha:b,integration_head:c,
    impact:{category:'mixed'},changedPaths:['scripts/a.mjs'],newIds:[],
    regressionIds:[],removed:[]};
  const digest=convergenceBatchDigest(batch);
  assert.match(digest,DIGEST);
  assert.match(convergencePrMarker(batch),/nession-convergence-pr:v1/);
  assert.notEqual(convergenceBatchDigest({...batch,changedPaths:['scripts/b.mjs']}),digest);
  assert.notEqual(convergenceBatchDigest({...batch,impact:{category:'tooling-only'}}),digest);
  assert.throws(()=>convergenceBatchDigest({...batch,impact:{category:'tooling'}}),/invalid/);
  assert.equal(convergenceApproval(batch).reason,'AUTOMATED_SCOPED_SOURCE_POLICY');
  assert.equal(convergenceApproval(batch).approved,true,
    'mixed-risk source with scoped green checks does not wait for Full');
  assert.equal(convergenceApproval(batch,{verified:true,source_head_sha:c,
    batch_digest:digest,run_id:777}).approved,true);
  assert.equal(convergenceApproval({...batch,impact:{category:'tooling-only'}}).approved,true);
  assert.equal(convergenceApproval({...batch,impact:{category:'unknown'}}).reason,
    'UNCLASSIFIED_BATCH_SCOPE');
  assert.equal(convergenceApproval({...batch,removed:['deleted-test']}).reason,
    'REMOVED_E2E_TESTS_REQUIRE_SOURCE_REPAIR');
  const fullTitle=fullRegressionTitle(batch);
  assert.match(fullTitle,/^Convergence Full chore\/staging-sync-/);
  const run={id:777,run_attempt:2,name:fullTitle,
    path:'.github/workflows/e2e-full-regression.yml@refs/heads/main',
    display_title:fullTitle,event:'workflow_dispatch',
    head_branch:'main',repository:{full_name:REPO},
    head_repository:{full_name:REPO},status:'completed',conclusion:'success'};
  const fullJob={name:'full',run_id:777,run_attempt:2,
    status:'completed',conclusion:'success',
    steps:['Resolve immutable branch/SHA target',
      'Run full canonical Playwright suite at pinned SHA',
      'Verify complete per-ID assertions'].map(name=>({
        name,status:'completed',conclusion:'success'}))};
  assert.equal(latestConvergenceFull(batch,[run])?.id,777,
    'live GitHub API puts dynamic run-name in both name and display_title');
  const legacyNameRun={...run,name:'E2E / Full Regression'};
  assert.equal(latestConvergenceFull(batch,[legacyNameRun])?.id,777,
    'static workflow-name still accepted with exact path and batch identity');
  assert.equal(latestConvergenceFull(batch,[{...run,name:'unrelated'}]),null);
  assert.equal(latestConvergenceFull(batch,[{...run,display_title:'unrelated'}]),null);
  assert.equal(latestConvergenceFull(batch,[{...run,path:'.github/workflows/foreign.yml'}]),null);
  assert.equal(latestConvergenceFull(batch,[{...run,head_branch:'staging'}]),null);
  assert.equal(latestConvergenceFull(batch,[{...run,event:'push'}]),null);
  assert.equal(latestConvergenceFull(batch,[{...run,head_repository:{full_name:'other/repo'}}]),null);
  assert.throws(()=>latestConvergenceFull(batch,Array(100).fill(run)),/unbounded/);
  const fullReceipt=attestConvergenceFull(batch,run,[fullJob]);
  assert.ok(fullReceipt?.verified);
  assert.ok(attestConvergenceFull(batch,legacyNameRun,[fullJob])?.verified);
  assert.equal(attestConvergenceFull(batch,{...run,name:'unrelated'},[fullJob]),null);
  assert.equal(attestConvergenceFull(batch,{...run,path:'.github/workflows/foreign.yml'},[fullJob]),null);
  assert.equal(convergenceApproval(batch,fullReceipt).approved,true);
  assert.equal(attestConvergenceFull(batch,{...run,conclusion:'failure'},[fullJob]),null);
  assert.equal(attestConvergenceFull(batch,{...run,display_title:'other'},[fullJob]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,run_attempt:1}]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,steps:fullJob.steps.slice(1)}]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,conclusion:'skipped'}]),null);
  assert.equal(convergenceApproval(batch,{...fullReceipt,source_head_sha:a}).approved,true,
    'unrelated/stale Full receipts cannot block scoped convergence');
  assert.throws(()=>convergenceBatchDigest({...batch,branch:'bad..branch'}),/invalid/);
  // Real Git object graph: test source-scope reconstruction, historical
  // changed-browser-ID selection, later Main advance and merged-push proof.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-convergence-pr-'));
  try{
    const run=(...args)=>git(root,...args);
    run('init','-q','-b','main');
    run('config','user.name','CI Fixture');
    run('config','user.email','ci@example.invalid');
    fs.mkdirSync(path.join(root,'e2e/tests/browser'),{recursive:true});
    fs.writeFileSync(path.join(root,'e2e/tests/browser/login.spec.ts'),'// base\n');
    run('add','.');run('commit','-qm','base');
    run('checkout','-qb','staging');
    fs.writeFileSync(path.join(root,'STAGING.md'),'stage\n');
    run('add','.');run('commit','-qm','staging own');
    const lane=run('rev-parse','HEAD');
    run('checkout','-q','main');
    fs.writeFileSync(path.join(root,'e2e/tests/browser/login.spec.ts'),'// regression\n');
    fs.writeFileSync(path.join(root,'e2e/tests/browser/new-browser.spec.ts'),'// new\n');
    run('add','.');run('commit','-qm','main browser IDs');
    const main=run('rev-parse','HEAD');
    run('update-ref','refs/remotes/origin/main',main);
    const tree=run('merge-tree','--write-tree',lane,main).split(/\s+/)[0];
    const head=run('commit-tree',tree,'-p',lane,'-p',main,'-m','source integration');
    const source=planBatch({branch:'staging',main_sha:main,lane_sha:lane,
      integration_head:head,repoRoot:root});
    const pr={
      number:17,state:'open',
      body:'Staging Convergence automated proposal\n\n'+convergencePrMarker(source),
      base:{ref:'staging',sha:lane,repo:{full_name:REPO}},
      head:{ref:integrationBranch('staging',main,lane),sha:head,repo:{full_name:REPO}},
    };
    run('checkout','--detach',head);
    const selected=convergenceE2ESelection(pr,root,lane);
    assert.equal(selected.mode,'selected');
    assert.deepEqual(selected.selected.map(x=>x.id),['login','new-browser']);
    assert.deepEqual(selected.issues,[]);
    assert.match(selected.plan_digest,DIGEST);
    assert.equal(selected.plan_digest,planDigest(selected),
      '#3311 convergence plan digest covers the canonical obligation fields');
    assert.notEqual(selected.plan_digest,sha256(selected),
      '#3311 convergence provenance must not be hashed into the plan digest');
    assert.deepEqual(convergenceE2ESelection(pr,root,lane),selected);
    assert.throws(()=>verifiedConvergenceBatch(
      {...pr,body:pr.body.replace(convergenceBatchDigest(source),'0'.repeat(64))},
      root,lane),/digest/);
    assert.throws(()=>verifiedConvergenceBatch(
      {...pr,base:{...pr.base,sha:'d'.repeat(40)}},
      root,lane),/base advanced/);
    // The next Main commit is not part of the approved PR and must not
    // change its previously verified selected plan or digest.
    run('checkout','-q','main');
    fs.writeFileSync(path.join(root,'NEXT.md'),'later main update\n');
    run('add','.');run('commit','-qm','later main commit');
    const later=run('rev-parse','HEAD');
    run('update-ref','refs/remotes/origin/main',later);
    run('checkout','--detach',head);
    assert.deepEqual(convergenceE2ESelection(pr,root,lane),selected);
    // The resulting staging merge has first parent lane and second parent H.
    const merged=run('commit-tree',tree,'-p',lane,'-p',head,
      '-m','merge checked source into staging');
    run('checkout','--detach',merged);
    const pushed=convergenceE2ESelection(pr,root,lane,merged);
    assert.equal(pushed.target_sha,merged);
    assert.deepEqual(pushed.selected,selected.selected);
    assert.notEqual(pushed.plan_digest,selected.plan_digest);
    assert.throws(()=>verifiedConvergenceBatch(pr,root,main,merged),
      /metadata|parents|source/);
    run('update-ref','refs/remotes/origin/main',lane);
    assert.throws(()=>verifiedConvergenceBatch(pr,root,lane,merged),/ancestry/);
    // #3211: a trusted Publisher promotion is not a source-sync PR and
    // carries no disposable Requirement Issue, yet it MUST execute actual
    // selected browser assertions, not report Not Required or unresolved.
    for(const id of BROWSER_DESIGN_IDS)
      fs.writeFileSync(path.join(root,'e2e/tests/browser',id+'.spec.ts'),
        '// canonical browser-design fixture\n');
    // Unlike login/new-browser (which already exist at the exact Main base),
    // this is a genuinely added Staging-only runnable ID. Its delta MUST be selected.
    fs.writeFileSync(path.join(root,'e2e/tests/browser/promotion-delta.spec.ts'),
      '// new promotion-only browser case\n');
    run('add','.');run('commit','-qm','staging design catalog and promotion delta');
    const promoteSha=run('rev-parse','HEAD');
    const promotion={
      number:19,title:'release: promote staging to main',
      user:{login:'nession-publisher[bot]'},
      body:'Staging Convergence automated proposal (source: Release / Staging Convergence).'+
        '\n\n- Direction: staging -> main\n- Planned main SHA: '+main+
        '\n- Planned lane SHA: '+promoteSha+'\n',
      base:{ref:'main',sha:main,repo:{full_name:REPO}},
      head:{ref:'staging',sha:promoteSha,repo:{full_name:REPO}},
    };
    assert.equal(isNativePromotionPr(promotion),true);
    assert.equal(isNativePromotionPr({...promotion,user:{login:'attacker'}}),false);
    assert.equal(isNativePromotionPr({...promotion,head:{...promotion.head,ref:'feature'}}),false);
    // Shape-only identity accepts valid looking historical pins; actual
    // Git ancestry is the trusted reject point for a forged source.
    const forgedMain={...promotion,body:promotion.body.replace(main,later)};
    assert.equal(isNativePromotionPr(forgedMain),true);
    assert.throws(()=>promotionE2ESelection(forgedMain,root,main),
      /untrusted|stale/,'future Main pin cannot authorize current base');
    const promoter=promotionE2ESelection(promotion,root,main);
    assert.equal(promoter.mode,'selected');
    assert.deepEqual(promoter.issues,[]);
    assert.deepEqual(promoter.selected.map(x=>x.id),['promotion-delta'],
      'promotion selects only the modified browser ID');
    assert.ok(promoter.selected.some(x=>x.id==='promotion-delta'),
      'changed browser ID from exact Main..Staging source must be selected');
    assert.ok(!promoter.selected.some(x=>['login','new-browser'].includes(x.id)),
      'unchanged Main-owned browser IDs must not be over-selected');
    assert.equal(promotionE2EPlan({baseSha:main,targetSha:promoteSha,ids:[],
      convergence:{}}).mode,'not-required',
      'a no-browser-delta promotion must not run universal browser cases');
    assert.equal(promoter.plan_digest,planDigest(promoter),
      '#3311 promotion plan digest covers the canonical obligation fields');
    assert.notEqual(promoter.plan_digest,sha256(promoter),
      '#3311 promotion provenance must not be hashed into the plan digest');
    assert.deepEqual(promotionE2ESelection(promotion,root,main),promoter);
    // The real #3208 kept its bot-authored creation SHA while protected
    // Staging advanced. New PR head is permitted ONLY as a descendant of
    // that pinned lane, and receives a new exact-head plan and digest.
    fs.writeFileSync(path.join(root,'PROMOTION_NEXT.md'),'new staging head\n');
    run('add','.');run('commit','-qm','advance staging while promotion is open');
    const advancedSha=run('rev-parse','HEAD');
    const advancedPr={...promotion,head:{...promotion.head,sha:advancedSha}};
    assert.ok(isNativePromotionPr(advancedPr));
    const advanced=promotionE2ESelection(advancedPr,root,main);
    assert.equal(advanced.target_sha,advancedSha);
    assert.notEqual(advanced.plan_digest,promoter.plan_digest);
    assert.deepEqual(advanced.selected,promoter.selected,
      'unchanged executable IDs remain selected at new source revision');
    const unrelatedPinned={...advancedPr,
      body:advancedPr.body.replace(promoteSha,later)};
    assert.throws(()=>promotionE2ESelection(unrelatedPinned,root,main),
      /untrusted|stale/,'unrelated pinned Staging source cannot authorize newer PR head');
    // Main's fast-track PRs can move its protected ref too. The new Main
    // must first be incorporated into Staging: the original pinned Main is
    // a verified ancestor floor, not a permanently frozen base SHA.
    const promotedTree=run('merge-tree','--write-tree',advancedSha,later).split(/\s+/)[0];
    const rebasedHead=run('commit-tree',promotedTree,
      '-p',advancedSha,'-p',later,'-m','merge newer Main into Staging');
    run('checkout','--detach',rebasedHead);
    const nextPr={...advancedPr,
      base:{...advancedPr.base,sha:later},
      head:{...advancedPr.head,sha:rebasedHead}};
    assert.ok(isNativePromotionPr(nextPr));
    const next=promotionE2ESelection(nextPr,root,later);
    assert.equal(next.base_sha,later);
    assert.equal(next.target_sha,rebasedHead);
    assert.notEqual(next.plan_digest,advanced.plan_digest);
    const badMainFloor={...nextPr,
      body:nextPr.body.replace(main,lane)};
    assert.throws(()=>promotionE2ESelection(badMainFloor,root,later),
      /untrusted|stale/,'unrelated pinned Main source must not authorize newer base');
    run('checkout','--detach',promoteSha);
    assert.throws(()=>promotionE2ESelection(promotion,root,lane),/untrusted/);
    assert.throws(()=>promotionE2ESelection(promotion,root,main,head),/untrusted/);
    assert.throws(()=>promotionE2ESelection({...promotion,
      base:{...promotion.base,sha:lane}},root,lane),/untrusted|stale/);
    // Delete an original runnable ID: it must never silently become a
    // Not Required receipt or a synthesized passing test result.
    run('rm','e2e/tests/browser/login.spec.ts');
    run('commit','-qm','remove original browser ID');
    const removedSha=run('rev-parse','HEAD');
    const removedPr={...promotion,head:{...promotion.head,sha:removedSha},
      body:promotion.body.replace(promoteSha,removedSha)};
    assert.throws(()=>promotionE2ESelection(removedPr,root,main),/removed runnable/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  console.log('PR-native convergence: immutable Git source, historical E2E, approval PASS');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&
   process.argv[2]==='self-test')selfTest();
