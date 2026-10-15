#!/usr/bin/env node
// #1690: no-network disposable bare-Git fixtures. These tests must never use
// production orphan refs, GitHub tokens, live Rulesets or external anchors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publish} from './run-store-cas-push.mjs';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'run-store-cas-test-'));
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024,
}).trim();
function clone(remote,name,branch){
  const dir=path.join(tmp,name);
  execFileSync('git',['clone','-q','-b',branch,remote,dir],{stdio:'pipe'});
  git(dir,'config','user.name','run-store-test');
  git(dir,'config','user.email','run-store-test@example.invalid');
  return dir;
}
function add(dir,filename,content){
  const full=path.join(dir,filename);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,content);
  git(dir,'add','-A');
  git(dir,'commit','-qm','fixture append');
}
function bare(branch,filename,content,label){
  const remote=path.join(tmp,label+'.git');
  fs.mkdirSync(remote);
  git(remote,'init','--bare','-q');
  const seed=path.join(tmp,label+'-seed');
  fs.mkdirSync(seed);
  git(seed,'init','-q');
  git(seed,'config','user.name','run-store-test');
  git(seed,'config','user.email','run-store-test@example.invalid');
  git(seed,'remote','add','origin',remote);
  add(seed,filename,content);
  git(seed,'push','-q','origin','HEAD:refs/heads/'+branch);
  return remote;
}
try{
  const remote=bare('acceptance-results','runs/root.json','{}\n','acceptance');
  const a=clone(remote,'acceptance-a','acceptance-results');
  const b=clone(remote,'acceptance-b','acceptance-results');
  add(a,'runs/a.json','{"a":true}\n');
  add(b,'runs/b.json','{"b":true}\n');
  const receipts=path.join(tmp,'receipts');
  process.env.RUN_STORE_RECEIPT_DIR=receipts;
  process.env.GITHUB_REPOSITORY='BestNathan/nession';
  process.env.GITHUB_RUN_ID='1234';
  process.env.GITHUB_SHA='a'.repeat(40);
  const first=publish('acceptance-results',a);
  assert.equal(first.replayed,false);
  const second=publish('acceptance-results',b);
  assert.equal(second.replayed,false);
  assert.notEqual(second.commit_sha,first.commit_sha,'stale head must produce rebased commit');
  assert.equal(git(b,'show','HEAD:runs/a.json'),'{"a":true}');
  assert.equal(git(b,'show','HEAD:runs/b.json'),'{"b":true}');
  // Same bytes of already-published key with stale base => no new commit.
  add(a,'runs/b.json','{"b":true}\n');
  const replay=publish('acceptance-results',a);
  assert.equal(replay.replayed,true);
  assert.equal(replay.commit_sha,second.commit_sha);
  // Existing immutable path may never be edited (even absent concurrency).
  const edited=clone(remote,'acceptance-edited','acceptance-results');
  add(edited,'runs/b.json','{"b":false}\n');
  assert.throws(()=>publish('acceptance-results',edited),/forbidden acceptance-results M/);
  // Concurrent same-key divergent creates must fail instead of last-write-wins.
  const collisionRemote=bare('task-results','runs/root.json','{}\n','task');
  const c=clone(collisionRemote,'task-c','task-results');
  const d=clone(collisionRemote,'task-d','task-results');
  add(c,'runs/record.json','one');
  add(d,'runs/record.json','two');
  publish('task-results',c);
  assert.throws(()=>publish('task-results',d),/divergent record, index or projection collision/);
  // Derived metrics may change, but must reject concurrent stale projections.
  const metricRemote=bare('metrics','metrics.json','{"v":0}\n','metrics');
  const m1=clone(metricRemote,'metrics-a','metrics');
  const m2=clone(metricRemote,'metrics-b','metrics');
  add(m1,'metrics.json','{"v":1}\n');
  add(m2,'metrics.json','{"v":2}\n');
  publish('metrics',m1);
  assert.throws(()=>publish('metrics',m2),/divergent record, index or projection collision/);
  const artifactFiles=fs.readdirSync(receipts);
  assert.ok(artifactFiles.length>=4);
  const objects=artifactFiles.map(x=>JSON.parse(fs.readFileSync(path.join(receipts,x),'utf8')));
  assert.ok(objects.some(x=>x.status==='idempotent-replay'));
  assert.ok(objects.some(x=>x.source.run_id==='1234'&&x.records.some(r=>
    /^([a-f0-9]{64})$/.test(r.sha256)&&r.path==='runs/a.json')));
  assert.ok(objects.every(x=>x.trust_level==='trusted_workflow_artifact_not_independent_anchor'));
  // Missing/unprovisioned refs must not be silently recreated.
  const absent=bare('task-results','runs/root.json','{}\n','missing-root');
  const missing=clone(absent,'missing-local','task-results');
  add(missing,'runs/new.json','new');
  git(absent,'update-ref','-d','refs/heads/task-results');
  assert.throws(()=>publish('task-results',missing),/remote ref missing/);
  console.log('Run Store CAS Gate: concurrent appends, replay, immutable/index collision, stale metrics CAS, receipts and ref deletion rejection passed');
}finally{
  delete process.env.RUN_STORE_RECEIPT_DIR;
  fs.rmSync(tmp,{recursive:true,force:true});
}
