#!/usr/bin/env node
// Trusted-operator publisher: one atomic Git commit for current topics,
// derived index and append-only global CHANGELOG. No per-entry revisions,
// events, or follow-up receipt commits; Git history is the audit record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const CHECKER=path.join(path.dirname(fileURLToPath(import.meta.url)),'knowledge-ledger-contract.mjs');
const SHA=/^[a-f0-9]{40}$/;
function git(dir,...args){
  const p=spawnSync('git',['-C',dir,...args],{encoding:'utf8',maxBuffer:2*1024*1024});
  if(p.status!==0)throw Error('git '+args.join(' ')+' failed: '+(p.stderr||p.stdout).trim());
  return p.stdout.trim();
}
function remoteHead(dir){
  const lines=git(dir,'ls-remote','--heads','origin','refs/heads/knowledge').split('\n').filter(Boolean);
  if(lines.length!==1||!SHA.test(lines[0].split(/\s+/)[0]))throw Error('knowledge ref missing or ambiguous');
  return lines[0].split(/\s+/)[0];
}
function publish(dir,expected,fixture=false){
  if(!SHA.test(expected))throw Error('expected knowledge head SHA required');
  if(git(dir,'rev-parse','--show-toplevel')!==path.resolve(dir))throw Error('use an isolated worktree root');
  const branch=git(dir,'symbolic-ref','--quiet','--short','HEAD');
  if(['main','staging','knowledge'].includes(branch))throw Error('cannot publish from shared/product checkout');
  if(!fixture){
    if(!/(?:github\.com[:/])BestNathan\/nession(?:\.git)?$/.test(git(dir,'remote','get-url','origin')))throw Error('wrong repository origin');
    if(process.env.GITHUB_ACTIONS==='true'&&(process.env.GITHUB_REF!=='refs/heads/main'||
      !['workflow_dispatch','schedule','push'].includes(process.env.GITHUB_EVENT_NAME)))
      throw Error('untrusted Actions job cannot publish');
  }
  if(git(dir,'status','--porcelain'))throw Error('commit all changes before publishing');
  const head=git(dir,'rev-parse','HEAD');
  git(dir,'merge-base','--is-ancestor',expected,head);
  const observed=remoteHead(dir);
  if(observed!==expected && observed!==head)throw Error('STALE_HEAD expected='+expected+' observed='+observed);
  const v=spawnSync(process.execPath,[CHECKER,'check',dir,expected],{encoding:'utf8',timeout:30000});
  if(v.status!==0)throw Error('knowledge contract rejected publication: '+(v.stderr||v.stdout));
  if(observed===expected&&head!==expected)git(dir,'push','origin','HEAD:refs/heads/knowledge');
  if(remoteHead(dir)!==head)throw Error('readback HEAD mismatch');
  return {ledger_head:head,commit_url:'https://github.com/BestNathan/nession/commit/'+head};
}
function selfTest(){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-v2-publish-'));
  // Pure Git force-free semantics regression: concurrent fast-forward writes
  // cannot overwrite a sibling; same-head replay is idempotent.
  try{
    const bare=path.join(d,'remote.git'),a=path.join(d,'a'),b=path.join(d,'b');
    git(d,'init','--bare','-q',bare);
    fs.mkdirSync(a);
    git(a,'init','-q');git(a,'config','user.name','Fixture');git(a,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(a,'README.md'),'base\n');git(a,'add','.');git(a,'commit','-qm','base');
    const base=git(a,'rev-parse','HEAD');git(a,'remote','add','origin',bare);git(a,'push','-q','origin','HEAD:refs/heads/knowledge');
    git(d,'clone','-q','-b','knowledge',bare,b);git(b,'config','user.name','Fixture');git(b,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(a,'a.txt'),'A\n');git(a,'add','.');git(a,'commit','-qm','writer A');
    fs.writeFileSync(path.join(b,'b.txt'),'B\n');git(b,'add','.');git(b,'commit','-qm','writer B');
    git(a,'push','origin','HEAD:refs/heads/knowledge');
    const first=remoteHead(a);assert.equal(first,git(a,'rev-parse','HEAD'));
    assert.throws(()=>git(b,'push','origin','HEAD:refs/heads/knowledge'),/failed|rejected|fetch first/i);
    assert.equal(remoteHead(b),first);
    git(a,'push','origin','HEAD:refs/heads/knowledge');
    assert.equal(remoteHead(a),first);
    assert.notEqual(base,first);
    console.log('knowledge-ledger-publish: force-free stale writer rejected and same-head replay passed');
  }finally{fs.rmSync(d,{recursive:true,force:true});}
}
const [cmd,root,sha]=process.argv.slice(2);
try{
  if(cmd==='self-test')selfTest();
  else if(cmd==='publish'&&root&&sha)console.log(JSON.stringify(publish(path.resolve(root),sha)));
  else throw Error('usage: self-test | publish <isolated-worktree> <expected-remote-head>');
}catch(e){console.error('knowledge-ledger-publish: '+e.message);process.exitCode=1;}
