#!/usr/bin/env node
// PR-native, source-bound Staging integration contract. A GitHub PR is the
// batch; ordinary feature Issues remain independent. No per-sync Issue writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
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
export function verifiedConvergenceBatch(pr,repoRoot,baseSha,targetSha=pr?.head?.sha){
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
  if(git(repoRoot,'rev-parse','HEAD')!==targetSha)
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
export function convergenceApproval(batch,comments=[]){
  if(!Array.isArray(comments)||comments.length>=100)
    throw Error('unbounded native convergence approval inventory');
  const command=convergenceApprovalCommand(batch);
  const selected=batch.newIds.length+batch.regressionIds.length+batch.removed.length;
  // Pure CI tooling with no runnable test obligations is not an Owner risk
  // exception; all mixed/runner/runtime/unknown scopes still require approval.
  if(batch.impact.category==='tooling'&&selected===0)
    return {approved:true,reason:'SOURCE_BOUND_TOOLING_POLICY',approval_command:command};
  const owner=comments.some(c=>c?.body?.trim()===command &&
    c.user?.login==='BestNathan'&&!c.deleted_at);
  return {approved:owner,reason:owner?'SOURCE_BOUND_OWNER_APPROVED':
    'OWNER_APPROVAL_REQUIRED',approval_command:command};
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
  assert.equal(convergenceApproval(batch,[]).approved,false);
  assert.equal(convergenceApproval(batch,[{body:convergenceApprovalCommand(batch),
    user:{login:'BestNathan'}}]).approved,true);
  assert.equal(convergenceApproval(batch,[{body:convergenceApprovalCommand(batch),
    user:{login:'untrusted'}}]).approved,false);
  assert.equal(convergenceApproval({...batch,impact:{category:'tooling'}},[]).approved,true);
  assert.equal(convergenceApproval({...batch,impact:{category:'tooling'},
    regressionIds:['login']},[]).approved,false);
  assert.throws(()=>convergenceApproval(batch,new Array(100)),/unbounded/);
  assert.throws(()=>convergenceBatchDigest({...batch,branch:'bad..branch'}),/invalid/);
  console.log('PR-native convergence: immutable digest, risk and Owner approval PASS');
}
if(process.argv[2]==='self-test')selfTest();
