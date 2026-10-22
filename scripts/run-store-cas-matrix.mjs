#!/usr/bin/env node
// #1690 SC-04: actual runner-executed disposable *bare-Git* CAS matrix.
// Never calls GitHub write APIs or touches production orphan refs. Uses the
// production run-store-cas-push.mjs publisher with two independent clones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const publisher=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'run-store-cas-push.mjs');
const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const kinds=Object.freeze([
  {store:'acceptance-results',root:'runs/root.json',a:'runs/a.json',b:'runs/b.json',same:'runs/same.json'},
  {store:'task-results',root:'runs/root.json',a:'runs/a.json',b:'runs/b.json',same:'runs/same.json'},
  {store:'metrics',root:'raw/workflows/root.json',a:'raw/workflows/a.json',b:'raw/workflows/b.json',same:'raw/workflows/same.json'},
]);
function git(cwd,...args){
  return execFileSync('git',['-C',cwd,...args],{
    encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
function write(cwd,p,content){const file=path.join(cwd,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}
function commit(cwd,p,content,msg){write(cwd,p,content);git(cwd,'add','-A');git(cwd,'commit','-qm',msg);}
function clone(tmp,remote,name,branch){
  const dir=path.join(tmp,name);
  execFileSync('git',['clone','-q','-b',branch,remote,dir],{timeout:30000,stdio:'pipe'});
  git(dir,'config','user.name','nession-cas-fixture');
  git(dir,'config','user.email','fixture@example.invalid');
  return dir;
}
function fixture(tmp,k,label){
  const remote=path.join(tmp,label+'.git'),seed=path.join(tmp,label+'-seed');
  fs.mkdirSync(remote);fs.mkdirSync(seed);
  git(remote,'init','--bare','-q');
  git(seed,'init','-q');git(seed,'config','user.name','nession-cas-fixture');
  git(seed,'config','user.email','fixture@example.invalid');
  git(seed,'remote','add','origin',remote);
  commit(seed,k.root,'{"root":true}\n','baseline');
  git(seed,'push','-q','origin','HEAD:refs/heads/'+k.store);
  return remote;
}
const exec=promisify(execFile);
async function publish(cwd,store,opts={}){
  const env={...process.env,
    GITHUB_REPOSITORY:REPO,GITHUB_RUN_ID:'1234',GITHUB_RUN_ATTEMPT:'1',
    GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW_REF:REPO+'/.github/workflows/test.yml@refs/heads/main',
    RUN_STORE_RECEIPT_DIR:opts.receipts,
  };
  // The actual publisher fails closed when the remote HEAD changes during
  // fetch. These two test processes intentionally race that HEAD; exercise
  // the publisher's documented external-retry path instead of interpreting
  // an expected transient CAS preflight rejection as a fixture failure.
  // Only this specific fail-closed race is retried, at most three times.
  for(let attempt=0;attempt<4;attempt++){
    try {
      const {stdout}=await exec(process.execPath,[publisher,store,cwd],{
        env,timeout:50000,maxBuffer:1024*1024,encoding:'utf8'});
      return JSON.parse(stdout.trim());
    }catch(error) {
      if(attempt===3||
          !/remote head moved while fetching; retry externally/.test(
            String(error.stderr??error.message)))throw error;
      await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
    }
  }
}
function expectedFailure(promise,re){
  return assert.rejects(promise,e=>re.test(String(e.stderr||e.message)),String(re));
}
async function one(tmp,k){
  const receipts=path.join(tmp,k.store+'-receipts');
  fs.mkdirSync(receipts);
  // Real overlapping processes from the *same immutable base*. A losing push
  // must rebase after CAS failure instead of overwriting the winning append.
  const remote=fixture(tmp,k,k.store+'-concurrent');
  const a=clone(tmp,remote,k.store+'-a',k.store);
  const b=clone(tmp,remote,k.store+'-b',k.store);
  const base=git(a,'rev-parse','HEAD');
  commit(a,k.a,'{"writer":"a"}\n','append-a');
  commit(b,k.b,'{"writer":"b"}\n','append-b');
  const outcomes=await Promise.all([publish(a,k.store,{receipts}),publish(b,k.store,{receipts})]);
  assert.ok(outcomes.every(x=>x.replayed===false&&SHA.test(x.commit_sha)));
  const remoteHead=git(remote,'rev-parse','refs/heads/'+k.store);
  assert.equal(git(remote,'show',remoteHead+':'+k.a),'{"writer":"a"}');
  assert.equal(git(remote,'show',remoteHead+':'+k.b),'{"writer":"b"}');
  assert.equal(Number(git(remote,'rev-list','--count',base+'..'+remoteHead)),2);
  assert.equal(git(remote,'show','-s','--format=%P',remoteHead).split(' ').length,1);
  // Same key and SAME byte content => idempotent; NO extra commit.
  const c=clone(tmp,remote,k.store+'-same-a',k.store);
  const d=clone(tmp,remote,k.store+'-same-b',k.store);
  commit(c,k.same,'{"v":"identical"}\n','same-key-a');
  commit(d,k.same,'{"v":"identical"}\n','same-key-b');
  const same=await Promise.all([publish(c,k.store,{receipts}),publish(d,k.store,{receipts})]);
  assert.equal(same.filter(x=>x.replayed).length,1);
  assert.equal(same.filter(x=>!x.replayed).length,1);
  const afterSame=git(remote,'rev-parse','refs/heads/'+k.store);
  assert.equal(Number(git(remote,'rev-list','--count',remoteHead+'..'+afterSame)),1);
  assert.ok(same.every(x=>x.commit_sha===afterSame));
  // Two different bytes under immutable key => hard reject, not last write.
  const e=clone(tmp,remote,k.store+'-collision-a',k.store);
  const f=clone(tmp,remote,k.store+'-collision-b',k.store);
  commit(e,k.store==='metrics'?'raw/workflows/collision.json':'runs/collision.json','first\n','same-key-1');
  commit(f,k.store==='metrics'?'raw/workflows/collision.json':'runs/collision.json','second\n','same-key-2');
  const first=await publish(e,k.store,{receipts});
  await expectedFailure(publish(f,k.store,{receipts}),/divergent record, index or projection collision/);
  assert.equal(git(remote,'rev-parse','refs/heads/'+k.store),first.commit_sha);
  // A stale cloned candidate cannot overwrite an immutable record even if it
  // creates a perfectly valid fast-forward Git commit.
  const edited=clone(tmp,remote,k.store+'-edit',k.store);
  commit(edited,k.same,'{"v":"forged"}\n','overwrite immutable');
  await expectedFailure(publish(edited,k.store,{receipts}),/forbidden/);
  // Missing/disappearing ref must not be reinitialized with a new root.
  const missingRemote=fixture(tmp,k,k.store+'-deleted');
  const candidate=clone(tmp,missingRemote,k.store+'-missing',k.store);
  commit(candidate,k.a,'{"lost":true}\n','candidate-before-ref-deletion');
  git(missingRemote,'update-ref','-d','refs/heads/'+k.store);
  await expectedFailure(publish(candidate,k.store,{receipts}),/remote ref missing/);
  // Existing history must be linear and immutable, even when rewritten into
  // a ref that still exists with the same branch name.
  const rewrittenRemote=fixture(tmp,k,k.store+'-rewritten');
  const stale=clone(tmp,rewrittenRemote,k.store+'-stale',k.store);
  commit(stale,k.a,'{"stale":true}\n','stale-candidate');
  const attacker=clone(tmp,rewrittenRemote,k.store+'-attacker',k.store);
  git(attacker,'checkout','-q','--orphan','newroot');
  git(attacker,'rm','-rfq','.');
  commit(attacker,k.root,'{"replacement":true}\n','ref-replacement');
  git(attacker,'push','--force','-q','origin','HEAD:refs/heads/'+k.store);
  await expectedFailure(publish(stale,k.store,{receipts}),/remote is not a verified descendant/);
  // Metrics projections may be updated *sequentially*, never through a stale
  // parallel copy whose content diverges from the new remote projection.
  let projection='not_applicable';
  if(k.store==='metrics'){
    const projectionRemote=fixture(tmp,k,k.store+'-projection');
    const m1=clone(tmp,projectionRemote,'projection-1',k.store);
    const m2=clone(tmp,projectionRemote,'projection-2',k.store);
    commit(m1,'metrics.json','{"v":1}\n','projection-one');
    commit(m2,'metrics.json','{"v":2}\n','projection-two');
    await publish(m1,k.store,{receipts});
    await expectedFailure(publish(m2,k.store,{receipts}),/divergent record, index or projection collision/);
    projection='stale_conflict_rejected';
  }
  const files=fs.readdirSync(receipts).map(x=>JSON.parse(fs.readFileSync(path.join(receipts,x),'utf8')));
  assert.ok(files.some(x=>x.status==='idempotent-replay'));
  assert.ok(files.some(x=>x.status==='published'));
  assert.ok(files.every(x=>x.trust_level==='trusted_workflow_artifact_not_independent_anchor'));
  return {store:k.store,parallel_distinct_key:'two_commits_retained',identical_key:'exactly_one_commit_and_one_replay',
    divergent_same_key:'rejected',immutable_overwrite:'rejected',deleted_remote_ref:'rejected',
    unrelated_ref_rewrite:'rejected',stale_metrics_projection:projection,
    initial_tip:base,parallel_tip:remoteHead,final_tip:afterSame,
    publisher_receipts:files.length,execution:'disposable_bare_git'};
}
export async function runMatrix(){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-store-cas-matrix-'));
  try{
    const rows=[];
    for(const k of kinds)rows.push(await one(tmp,k));
    return {schema_version:1,kind:'isolated_run_store_cas_concurrency_matrix',
      repository:REPO,coverage:rows.length,total:3,
      verdict:'FixturePassed',stores:rows,
      production_ref_mutated:false,server_side_denial_verified:false,
      writer_identity_verified:false,independent_anchor_verified:false,
      note:'Actual concurrent OS processes and bare-Git CAS in an isolated runner; NOT live GitHub protected ref authorization'};
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
function assertReport(report){
  assert.deepEqual(report.stores.map(x=>x.store),kinds.map(x=>x.store));
  assert.equal(report.coverage,3);
  assert.ok(report.stores.every(x=>x.parallel_distinct_key==='two_commits_retained'&&
    x.identical_key==='exactly_one_commit_and_one_replay'&&x.divergent_same_key==='rejected'&&
    x.deleted_remote_ref==='rejected'&&x.unrelated_ref_rewrite==='rejected'));
  assert.equal(report.server_side_denial_verified,false);
}
async function main(){
  const mode=process.argv[2];
  if(mode==='self-test'){
    const report=await runMatrix();assertReport(report);
    const wf=fs.readFileSync('.github/workflows/store-governance-audit.yml','utf8');
    assert.match(wf,/run-store-cas-matrix\.mjs collect/);
    assert.match(wf,/permissions:\s*\n  contents: read\s*\n  actions: read/);
    assert.doesNotMatch(wf,/contents: write|RUN_STORE_WRITER_APP_PRIVATE_KEY/);
    console.log('run store isolated concurrent CAS 3/3; replay/collision/history negatives passed');
  }else if(mode==='collect'){
    if(process.env.GITHUB_REPOSITORY!==REPO||process.env.GITHUB_REF!=='refs/heads/main'||
       !SHA.test(process.env.GITHUB_SHA??''))throw Error('trusted main-only audit context required');
    const output=process.argv[3];
    if(!output||!path.isAbsolute(output)||fs.existsSync(output))throw Error('fresh absolute output required');
    const report=await runMatrix();assertReport(report);
    report.observed_main_sha=process.env.GITHUB_SHA;
    report.workflow_run_id=process.env.GITHUB_RUN_ID??null;
    report.workflow_run_attempt=process.env.GITHUB_RUN_ATTEMPT??null;
    fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      '### Isolated concurrent CAS matrix\n\n3/3 stores; source replay/collision/parallel CAS confirmed in disposable bare Git. **No GitHub server-side denial or independent anchor claimed.**\n');
    console.log(JSON.stringify({kind:report.kind,coverage:report.coverage,total:report.total,verdict:report.verdict}));
  }else throw Error('usage: self-test | collect ABS_REPORT');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{await main();}catch(e){console.error('::error::'+String(e.stack||e));process.exitCode=1;}
}
