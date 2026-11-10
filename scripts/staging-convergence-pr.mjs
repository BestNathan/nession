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
    !['tooling','e2e-runner','app-runtime','e2e-fixture-catalog','mixed','unknown']
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
  const plan={
    schema_version:1,kind:'issue_e2e_selection',base_sha:baseSha,
    target_sha:targetSha,issues:[],
    selected:ids.map(id=>({id,owners:[]})),
    mode:ids.length?'selected':'not-required',
    convergence:{
      source_head_sha:batch.integration_head,main_sha:batch.main_sha,
      lane_sha:batch.lane_sha,batch_digest:convergenceBatchDigest(batch),
      risk:batch.impact.category,
    },
  };
  return {...plan,plan_digest:sha256(plan)};
}
export function convergenceApprovalCommand(batch){
  return '/approve-staging-convergence '+batch.integration_head+' '+
    convergenceBatchDigest(batch);
}
// A fully verified independent Full E2E source run replaces per-batch
// human approval for risk-bearing known source changes. Missing/failed source
// evidence never becomes a policy Pass, and unknown or removed test scope
// cannot be rubber-stamped by either an Owner comment or a model verdict.
export function fullRegressionTitle(batch){
  convergenceBatchDigest(batch); // validate immutable source/plan identity
  return 'Convergence Full '+integrationBranch(batch.branch,
    batch.main_sha,batch.lane_sha)+'@'+batch.integration_head;
}
export function latestConvergenceFull(batch,runs=[]){
  if(!Array.isArray(runs)||runs.length>=100)
    throw Error('unbounded exact-source Full E2E run inventory');
  const title=fullRegressionTitle(batch);
  return runs.filter(run=>run.display_title===title&&
    run.name==='E2E / Full Regression'&&
    run.event==='workflow_dispatch'&&run.head_branch==='main'&&
    run.repository?.full_name===REPO&&run.head_repository?.full_name===REPO&&
    run.path?.split('@')[0]==='.github/workflows/e2e-full-regression.yml')
    .sort((a,b)=>(b.run_number??0)-(a.run_number??0)||
      (b.run_attempt??0)-(a.run_attempt??0)||(b.id??0)-(a.id??0))[0]??null;
}

export function attestConvergenceFull(batch,run,jobs=[]){
  const title=fullRegressionTitle(batch);
  if(!run||run.name!=='E2E / Full Regression'||
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
export function convergenceApproval(batch,fullReceipt=null){
  const digest=convergenceBatchDigest(batch);
  if(batch.impact.category==='unknown')
    return {approved:false,reason:'UNCLASSIFIED_BATCH_SCOPE'};
  if(batch.removed.length>0)
    return {approved:false,reason:'REMOVED_E2E_TESTS_REQUIRE_SOURCE_REPAIR'};
  if(batch.impact.category==='tooling-only' &&
      batch.newIds.length===0&&batch.regressionIds.length===0)
    return {approved:true,reason:'AUTOMATED_TOOLING_SOURCE_POLICY'};
  if(!fullReceipt?.verified||fullReceipt.source_head_sha!==batch.integration_head||
      fullReceipt.batch_digest!==digest||
      !Number.isSafeInteger(fullReceipt.run_id)||fullReceipt.run_id<=0)
    return {approved:false,reason:'AWAITING_EXACT_HEAD_FULL_E2E',
      full_run_title:fullRegressionTitle(batch)};
  return {approved:true,reason:'AUTOMATED_VERIFIED_FULL_E2E',
    full_run_id:fullReceipt.run_id};
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
  assert.notEqual(convergenceBatchDigest({...batch,impact:{category:'tooling'}}),digest);
  assert.equal(convergenceApproval(batch).reason,'AWAITING_EXACT_HEAD_FULL_E2E');
  assert.equal(convergenceApproval(batch,{verified:true,source_head_sha:c,
    batch_digest:digest,run_id:777}).approved,true);
  assert.equal(convergenceApproval({...batch,impact:{category:'tooling-only'}}).approved,true);
  assert.equal(convergenceApproval({...batch,impact:{category:'unknown'}}).reason,
    'UNCLASSIFIED_BATCH_SCOPE');
  assert.equal(convergenceApproval({...batch,removed:['deleted-test']}).reason,
    'REMOVED_E2E_TESTS_REQUIRE_SOURCE_REPAIR');
  const fullTitle=fullRegressionTitle(batch);
  assert.match(fullTitle,/^Convergence Full chore\/staging-sync-/);
  const run={id:777,run_attempt:2,name:'E2E / Full Regression',
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
  assert.equal(latestConvergenceFull(batch,[run])?.id,777);
  assert.equal(latestConvergenceFull(batch,[{...run,display_title:'unrelated'}]),null);
  assert.throws(()=>latestConvergenceFull(batch,Array(100).fill(run)),/unbounded/);
  const fullReceipt=attestConvergenceFull(batch,run,[fullJob]);
  assert.ok(fullReceipt?.verified);
  assert.equal(convergenceApproval(batch,fullReceipt).approved,true);
  assert.equal(attestConvergenceFull(batch,{...run,conclusion:'failure'},[fullJob]),null);
  assert.equal(attestConvergenceFull(batch,{...run,display_title:'other'},[fullJob]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,run_attempt:1}]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,steps:fullJob.steps.slice(1)}]),null);
  assert.equal(attestConvergenceFull(batch,run,[{...fullJob,conclusion:'skipped'}]),null);
  assert.equal(convergenceApproval(batch,{...fullReceipt,source_head_sha:a}).approved,false);
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
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  console.log('PR-native convergence: immutable Git source, historical E2E, approval PASS');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&
   process.argv[2]==='self-test')selfTest();
