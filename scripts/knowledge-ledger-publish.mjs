#!/usr/bin/env node
/**
 * Trusted operator helper for publishing already-curated orphan knowledge.
 * Never supply credentials to PR-head code or model-generated shell commands.
 *
 * publish <isolated-knowledge-worktree> <expected-remote-head>
 * self-test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TRUSTED_CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-ledger-contract.mjs');
const SHA=/^[a-f0-9]{40}$/;
const digest=b=>createHash('sha256').update(b).digest('hex');
function git(root,...args){
  const p=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:1024*1024});
  if(p.status!==0)throw Error('git '+args[0]+' failed: '+(p.stderr||p.stdout).trim());
  return p.stdout.trim();
}
function remoteHead(root) {
  const rows=git(root,'ls-remote','--heads','origin','refs/heads/knowledge').split('\n').filter(Boolean);
  if(rows.length!==1||!SHA.test(rows[0].split(/\s+/)[0]))throw Error('missing or ambiguous remote knowledge ref');
  return rows[0].split(/\s+/)[0];
}
function check(root,expected){
  const p=spawnSync(process.execPath,[TRUSTED_CHECKER,'check',root,expected],
    {encoding:'utf8',maxBuffer:1024*1024,timeout:20000});
  if(p.status!==0)throw Error('knowledge contract rejected candidate: '+(p.stderr||p.stdout).trim());
}
function writeNew(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,bytes,{flag:'wx'});
}
function json(value){return JSON.stringify(value,null,2)+'\n';}
function appendReceipts(root,baseline,recordCommit) {
  const changed=git(root,'diff','--name-only','--no-renames',baseline,recordCommit,'--','events')
    .split('\n').filter(s=>s.startsWith('events/')&&s.endsWith('.json'));
  let count=0;
  for(const eventPath of changed){
    const event=JSON.parse(fs.readFileSync(path.join(root,eventPath),'utf8'));
    if(!event.new_revision)continue; // bootstrap does not describe a claim
    const recordPath='entries/'+event.id+'/'+event.new_revision+'.md';
    if(!fs.existsSync(path.join(root,recordPath)))throw Error('receipt record missing: '+recordPath);
    const origin=git(root,'log','--format=%H','--diff-filter=A','-n','1',recordCommit,'--',eventPath);
    if(!SHA.test(origin))throw Error('no source commit for '+eventPath);
    const receiptPath='receipts/'+path.basename(eventPath);
    const value={
      schema_version:1,event_path:eventPath,record_path:recordPath,
      content_sha256:digest(fs.readFileSync(path.join(root,recordPath))),
      commit_sha:origin,branch:'refs/heads/knowledge',
      written_at:new Date().toISOString(),source_issue:event.source_issue,
    };
    if(fs.existsSync(path.join(root,receiptPath))){
      const old=JSON.parse(fs.readFileSync(path.join(root,receiptPath),'utf8'));
      if(old.event_path!==value.event_path||old.record_path!==value.record_path||
          old.content_sha256!==value.content_sha256||old.commit_sha!==value.commit_sha)
        throw Error('divergent receipt: '+receiptPath);
    }else{writeNew(path.join(root,receiptPath),json(value));count++;}
  }
  return count;
}
function validateEnvironment(root,fixture){
  const dir=git(root,'rev-parse','--show-toplevel');
  if(path.resolve(dir)!==path.resolve(root))throw Error('must pass the isolated worktree root');
  const branch=git(root,'symbolic-ref','--quiet','--short','HEAD');
  if(['main','staging','knowledge'].includes(branch))throw Error('do not write in a product or shared-ref checkout');
  const origin=git(root,'remote','get-url','origin');
  if(!fixture && !/(?:github\.com[:/])BestNathan\/nession(?:\.git)?$/.test(origin))
    throw Error('origin must point at BestNathan/nession');
}
function publish(root,expected,{fixture=false}={}){
  if(!SHA.test(expected))throw Error('an exact expected knowledge ref head is mandatory');
  validateEnvironment(root,fixture);
  if(!fixture && process.env.GITHUB_ACTIONS==='true' &&
    (process.env.GITHUB_REF!=='refs/heads/main' ||
      !['workflow_dispatch','schedule','push'].includes(process.env.GITHUB_EVENT_NAME)))
    throw Error('untrusted GitHub Actions event/ref may not publish knowledge');
  if(git(root,'status','--porcelain'))throw Error('worktree must have no uncommitted changes');
  const head=git(root,'rev-parse','HEAD');
  git(root,'merge-base','--is-ancestor',expected,head);
  // The remote ref is read just before use. Non-force push also checks against
  // races that occur between this preflight and the actual update.
  const observed=remoteHead(root);
  if(observed!==expected && observed!==head)throw Error('STALE_HEAD: expected '+expected+' observed '+observed);
  check(root,expected);
  if(observed===expected && head!==expected){
    git(root,'push','origin','HEAD:refs/heads/knowledge'); // NEVER --force
    if(remoteHead(root)!==head)throw Error('record push readback differed from expected head');
  }
  // Same HEAD retry is idempotent. Missing post-commit receipts can be resumed
  // when the record commit has already landed but its receipt push has not.
  const created=appendReceipts(root,expected,head);
  if(created){
    git(root,'add','--','receipts');
    git(root,'commit','-m','docs(knowledge): append post-commit receipts');
    check(root,expected);
    try{git(root,'push','origin','HEAD:refs/heads/knowledge');}
    catch(e){throw Error('RECEIPT_PENDING: record remains published; reconcile concurrent ref and retry: '+e.message);}
    if(remoteHead(root)!==git(root,'rev-parse','HEAD'))throw Error('receipt push readback mismatch');
  }
  return {record_commit:head,ledger_head:remoteHead(root),receipts_created:created};
}
function selfTest(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-knowledge-push-'));
  const bare=path.join(temp,'remote.git'),seed=path.join(temp,'seed'),
    a=path.join(temp,'a'),b=path.join(temp,'b');
  const utc='2026-10-24T03:00:00Z';
  const put=(base,p,s)=>{const f=path.join(base,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);};
  try{
    fs.mkdirSync(seed);
    git(temp,'init','--bare','-q',bare);
    git(seed,'init','-q','-b','knowledge');
    git(seed,'config','user.name','Fixture');
    git(seed,'config','user.email','fixture@example.invalid');
    put(seed,'schema/v1.json',json({schema_version:1}));
    put(seed,'index.json',json({schema_version:1,updated_at:utc,entries:[]}));
    put(seed,'events/2026/10/24/knowledge-ledger-bootstrap.json',
      json({schema_version:1,id:'knowledge-ledger-bootstrap',action:'create',recorded_at:utc,
        actor:'fixture',reason:'initialize',source_issue:'https://github.com/BestNathan/nession/issues/2325',
        previous_revision:null,new_revision:null,content_sha256:null}));
    git(seed,'add','.');git(seed,'commit','-qm','orphan baseline');
    const base=git(seed,'rev-parse','HEAD');
    git(seed,'remote','add','origin',bare);
    git(seed,'push','-q','origin','HEAD:refs/heads/knowledge');
    git(temp,'clone','-q','-b','knowledge',bare,a);
    git(temp,'clone','-q','-b','knowledge',bare,b);
    const make=(r,id)=>{
      git(r,'checkout','-qb','kb-'+id);
      git(r,'config','user.name','Fixture');
      git(r,'config','user.email','fixture@example.invalid');
      const body='# '+id+'\n',h=digest(body),version='v0001';
      const original='a'.repeat(40),issue='https://github.com/BestNathan/nession/issues/2325';
      const metadata={schema_version:1,id,revision:version,title:id,summary:id,category:'test',
        tags:['test'],status:'verified',created_at:utc,recorded_at:utc,verified_at:utc,effective_at:null,
        supersedes:null,sources:[{url:'https://github.com/BestNathan/nession/blob/'+original+'/AGENTS.md',sha:original,role:'canonical'}],content_sha256:h};
      const event={schema_version:1,id,action:'create',recorded_at:utc,actor:'fixture',
        reason:'race negative fixture',source_issue:issue,previous_revision:null,new_revision:version,content_sha256:h};
      put(r,'entries/'+id+'/'+version+'.md',body);
      put(r,'entries/'+id+'/'+version+'.json',json(metadata));
      put(r,'events/2026/10/24/'+id+'-v0001.json',json(event));
      put(r,'index.json',json({schema_version:1,updated_at:utc,
        entries:[{id,title:id,summary:id,category:'test',tags:['test'],
          status:'verified',revision:version,path:'entries/'+id+'/'+version+'.md',
          metadata_path:'entries/'+id+'/'+version+'.json',updated_at:utc,content_sha256:h,sources:metadata.sources}]}));
      git(r,'add','.');git(r,'commit','-qm','add '+id);
    };
    make(a,'race-a');make(b,'race-b');
    const pass=publish(a,base,{fixture:true});
    assert.equal(pass.receipts_created,1);
    assert.equal(remoteHead(a),pass.ledger_head);
    const replay=publish(a,base,{fixture:true});
    assert.equal(replay.receipts_created,0,'identical replay creates no receipt');
    assert.equal(replay.ledger_head,pass.ledger_head,'identical replay keeps remote head');
    assert.throws(()=>publish(b,base,{fixture:true}),/STALE_HEAD/,'stale concurrent writer must fail');
    assert.equal(remoteHead(a),pass.ledger_head,'stale writer did not change remote head');
    console.log('knowledge-ledger-publish: full readback, receipt, duplicate and stale-writer fixtures passed');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
const [mode,root,expected]=process.argv.slice(2);
if(mode==='self-test')selfTest();
else if(mode==='publish'&&root&&expected){
  try{console.log(json(publish(path.resolve(root),expected)));}
  catch(e){console.error('knowledge-ledger-publish: '+e.message);process.exitCode=1;}
}else{console.error('usage: knowledge-ledger-publish.mjs self-test | publish <isolated-knowledge-worktree> <expected-ref-sha>');process.exitCode=2;}
