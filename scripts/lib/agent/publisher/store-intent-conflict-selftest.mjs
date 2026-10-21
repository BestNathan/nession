#!/usr/bin/env node
// Isolated, disposable Git fixtures for #2148 SC-02. This never contacts or
// modifies production agent-store; every remote is inside os.tmpdir().
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {publish} from '../../../run-store-cas-push.mjs';
import {commitControlledPublisherIntent,planControlledPublisherIntent,
  CONTROLLED_PUBLISHER_INTENT_PATH as RECORD} from './store-intent.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-publisher-cas-negative-'));
function git(...args){
  return execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:45000,
    stdio:['ignore','pipe','pipe']}).trim();
}
function checkout(remote,name){
  const dir=path.join(root,name);
  git('clone','-q','--single-branch','--branch','agent-store',remote,dir);
  git('-C',dir,'config','user.name','Fixture CAS');
  git('-C',dir,'config','user.email','fixture@example.invalid');
  return dir;
}
function version(rootDir,change){
  const rel='workflows/issues/1997/head.json',p=path.join(rootDir,rel);
  const value=JSON.parse(fs.readFileSync(p,'utf8'));
  fs.writeFileSync(p,JSON.stringify(change(value))+'\n');
  git('-C',rootDir,'add','--',rel);
  git('-C',rootDir,'commit','-qm','isolated negative fixture');
}
const request={target_main_sha:'a'.repeat(40),
  patch_sha256:'b'.repeat(64),issuer_run_id:50001};
try{
  const bare=path.join(root,'fixture.git');
  const seed=path.join(root,'seed');
  git('init','-q','--bare',bare);
  git('clone','-q',bare,seed);
  git('-C',seed,'config','user.name','Fixture');
  git('-C',seed,'config','user.email','fixture@example.invalid');
  git('-C',seed,'checkout','-qb','agent-store');
  const base='workflows/issues/1997';
  const filesDir=path.join('scripts','lib','agent','publisher','fixtures');
  fs.mkdirSync(path.join(seed,base,'states'),{recursive:true});
  fs.copyFileSync(path.join(filesDir,'1997-v16-state.json'),
    path.join(seed,base,'states','00000016.json'));
  fs.copyFileSync(path.join(filesDir,'1997-v16-head.json'),
    path.join(seed,base,'head.json'));
  git('-C',seed,'add','-A');
  git('-C',seed,'commit','-qm','isolated real v16 bytes');
  git('-C',seed,'push','-q','origin','agent-store');
  const origin=git('--git-dir',bare,'rev-parse','refs/heads/agent-store');

  for(const [name,transform] of [
    ['bad-hash',doc=>({...doc,sha256:'0'.repeat(64)})],
    ['old-version',doc=>({...doc,version:15,
      path:'workflows/issues/1997/states/00000015.json'})],
  ]){
    const remote=path.join(root,name+'.git');
    git('clone','-q','--bare',bare,remote);
    const dir=checkout(remote,name+'-work');
    version(dir,transform);
    git('-C',dir,'push','-q','origin','agent-store');
    const old=git('--git-dir',remote,'rev-parse','refs/heads/agent-store');
    assert.throws(()=>commitControlledPublisherIntent({
      remote,...request,
    }),Error,'invalid isolated Store head must reject new intent');
    assert.equal(git('--git-dir',remote,'rev-parse','refs/heads/agent-store'),
      old,'negative fixture should not receive a Writer commit');
  }
  assert.equal(git('--git-dir',bare,'rev-parse','refs/heads/agent-store'),
    origin,'all negative fixtures must keep original v16 unchanged');

  const sameKey=path.join(root,'competing.git');
  git('clone','-q','--bare',bare,sameKey);
  const payload=planControlledPublisherIntent(request);
  const candidates=[0,1].map(i=>{
    const dir=checkout(sameKey,'publisher-'+i);
    const target=path.join(dir,RECORD);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify({
      ...payload,publisher_issuer_run_id:request.issuer_run_id+i,
    },null,2)+'\n');
    git('-C',dir,'add','--',RECORD);
    git('-C',dir,'commit','-qm','two independent intent attempts');
    return dir;
  });
  const first=publish('agent-store',candidates[0],1);
  assert.equal(first.replayed,false);
  assert.throws(()=>publish('agent-store',candidates[1],1),
    /divergent record|projection collision/,
    'a second original-base writer must lose the same-key CAS');
  assert.equal(git('--git-dir',sameKey,'rev-parse','refs/heads/agent-store'),
    first.commit_sha);
  const retry=commitControlledPublisherIntent({remote:sameKey,...request});
  assert.equal(retry.status,'reconcile');
  assert.equal(retry.may_publish,false);
  console.log('Publisher Store CAS negatives: source v16, stale head, digest mismatch, same-key competing writers and replay verified on disposable bare Git');
}finally{fs.rmSync(root,{recursive:true,force:true});}
