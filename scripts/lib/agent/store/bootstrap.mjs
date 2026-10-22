#!/usr/bin/env node
// Bootstrap only an ABSENT agent-store orphan ref. Never force/update an existing
// ref and never emit credentials or pass a token to untrusted Agent code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const REF='refs/heads/agent-store';
const ROOT_MESSAGE='agent-store: trusted bootstrap';
const EMPTY_TREE='4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA=/^[a-f0-9]{40}$/;
function fail(message){throw new Error('agent-store bootstrap: '+message);}
function git(root,args){
  try {return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:45000,maxBuffer:1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();}catch(e){fail('git '+args[0]+' failed ('+(e.status??'unknown')+')');}
}
function verifyExisting(root,sha){
  if(!SHA.test(sha))fail('invalid remote head');
  git(root,['fetch','--no-tags','origin',REF]);
  if(git(root,['rev-parse','FETCH_HEAD'])!==sha)fail('remote advanced during verification');
  const roots=git(root,['rev-list','--max-parents=0',sha]).split('\n').filter(Boolean);
  if(roots.length!==1)fail('invalid Store root count');
  const base=roots[0];
  if(git(root,['rev-parse',base+'^{tree}'])!==EMPTY_TREE ||
      git(root,['show','-s','--format=%B',base])!==ROOT_MESSAGE)
    fail('remote agent-store has an unrecognized, non-orphan bootstrap');
}
export function bootstrapAgentStore(remote){
  if(!remote||typeof remote!=='string'||/\s/.test(remote))
    fail('authorized Git remote URL required');
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'agent-store-bootstrap-'));
  const root=path.join(parent,'repo');
  try{
    fs.mkdirSync(root);
    git(root,['init','-q','--initial-branch=agent-store']);
    git(root,['config','user.name','nession-agent-store']);
    git(root,['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);
    git(root,['remote','add','origin',remote]);
    const read=()=>git(root,['ls-remote','--heads','origin',REF]);
    const initial=read();
    if(initial){
      const match=/^([a-f0-9]{40})\trefs\/heads\/agent-store$/.exec(initial);
      if(!match)fail('ambiguous remote Store ref');
      verifyExisting(root,match[1]);
      return {changed:false,head_sha:match[1]};
    }
    git(root,['commit','--allow-empty','-q','-m',ROOT_MESSAGE]);
    const created=git(root,['rev-parse','HEAD']);
    if(!SHA.test(created)||git(root,['rev-list','--count','HEAD'])!=='1')
      fail('candidate is not a single orphan root');
    // Normal push: fails if another writer has created this ref concurrently.
    git(root,['push','origin','HEAD:'+REF]);
    const observed=read();
    if(observed!==created+'\t'+REF)fail('post-creation remote SHA mismatch');
    verifyExisting(root,created);
    return {changed:true,head_sha:created};
  }finally {fs.rmSync(parent,{recursive:true,force:true});}
}
function test(){
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'agent-store-bootstrap-test-'));
  try {
    git(parent,['init','--bare','-q',path.join(parent,'remote.git')]);
    const remote=path.join(parent,'remote.git');
    const first=bootstrapAgentStore(remote);
    if(!first.changed||!SHA.test(first.head_sha))fail('initial ref was not bootstrapped');
    const second=bootstrapAgentStore(remote);
    if(second.changed||second.head_sha!==first.head_sha)fail('repeat bootstrap changed existing ref');
    const foreign=path.join(parent,'foreign.git');
    git(parent,['init','--bare','-q',foreign]);
    const alien=path.join(parent,'alien');fs.mkdirSync(alien);
    git(alien,['init','-q']);
    git(alien,['config','user.name','Fixture']);
    git(alien,['config','user.email','fixture@example.invalid']);
    fs.writeFileSync(path.join(alien,'tracked'),'not an orphan');
    git(alien,['add','tracked']);
    git(alien,['commit','-qm','invalid bootstrap']);
    git(alien,['remote','add','origin',foreign]);
    git(alien,['push','-q','origin','HEAD:'+REF]);
    let rejected=false;
    try{bootstrapAgentStore(foreign);}catch(e){rejected=/unrecognized/.test(e.message);}
    if(!rejected)fail('non-orphan Store ref accepted');
    console.log('agent-store bootstrap: disposable orphan, idempotence, foreign-root denial passed');
  }finally{fs.rmSync(parent,{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  try{
    const mode=process.argv[2];
    if(mode==='self-test')test();
    else if(mode==='--apply'&&process.argv.length===3){
      if(process.env.GITHUB_REPOSITORY!=='BestNathan/nession'||
        process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_ACTIONS!=='true')
        fail('trusted main-owned GitHub Actions context required');
      const r=bootstrapAgentStore(process.env.AGENT_STORE_BOOTSTRAP_REMOTE);
      console.log(JSON.stringify({changed:r.changed,head_sha:r.head_sha,ref:REF}));
    }else fail('usage: self-test | --apply');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
