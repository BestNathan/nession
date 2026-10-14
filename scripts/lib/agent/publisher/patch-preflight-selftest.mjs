import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {preflightAgentPatch,inspectTextPatch,validPublisherFile} from './patch-preflight.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-patch-fixture-'));
const repo=path.join(root,'repo');fs.mkdirSync(repo);
const git=(args,options={})=>execFileSync('git',args,{cwd:repo,encoding:'utf8',...options}).trim();
const put=(name,value)=>{
  const file=path.join(repo,name);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,value);
};
try{
  git(['init','-q']);
  git(['config','user.name','Agent Test']);
  git(['config','user.email','agent@example.invalid']);
  put('src/calc.js','module.exports = (a,b) => a - b;\n');
  put('.github/workflows/ci.yml','name: secure\n');
  put('gates/security.sh','#!/bin/sh\nexit 1\n');
  put('src/normal.txt','normal\n');
  fs.symlinkSync('/tmp',path.join(repo,'src','link'));
  git(['add','-A']);git(['commit','-qm','safe base']);
  const sha=git(['rev-parse','HEAD']);
  const modifyPatch=(name,value)=>{
    put(name,value);const patch=git(['diff','--',name])+'\n';
    git(['checkout','--',name]);return patch;
  };
  const original=fs.readFileSync(path.join(repo,'src/calc.js'),'utf8');
  const good=modifyPatch('src/calc.js','module.exports = (a,b) => a + b;\n');
  assert.deepEqual(inspectTextPatch(good,['src/calc.js']),['src/calc.js']);
  const one=preflightAgentPatch({checkout:repo,source_sha:sha,patch:good,allowed_paths:['src/calc.js']});
  assert.equal(one.files.length,1);
  assert.equal(one.files[0].path,'src/calc.js');
  assert.match(one.patch_sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(one.files[0].old_sha256,one.files[0].new_sha256);
  assert.equal(one.scope,'preflight_only');
  assert.equal(fs.readFileSync(path.join(repo,'src/calc.js'),'utf8'),original);
  assert.deepEqual(preflightAgentPatch({checkout:repo,source_sha:sha,patch:good,
    allowed_paths:['src/calc.js']}),one);
  const bad=(input,regex)=>assert.throws(()=>
    preflightAgentPatch({checkout:repo,source_sha:sha,...input}),regex);
  const noop=good.replace('+module.exports = (a,b) => a + b;',
    '+module.exports = (a,b) => a - b;');
  bad({patch:noop,allowed_paths:['src/calc.js']},/applied changes do not match|no-op/);
  bad({patch:good,allowed_paths:['src/normal.txt']},/uniquely authorized/);
  bad({patch:good,allowed_paths:['src/calc.js','src/calc.js']},/invalid trusted/);
  bad({patch:good,allowed_paths:['../src/calc.js']},/unsafe or protected/);
  bad({patch:good,allowed_paths:['.github/workflows/ci.yml']},/unsafe or protected/);
  bad({patch:good,allowed_paths:['src/calc.js'],source_sha:'f'.repeat(40)},/wrong pinned SHA/);
  bad({patch:good.replace('a - b;','a ** b;'),allowed_paths:['src/calc.js']},/Git validation/);
  bad({patch:good+'GIT binary patch\n',allowed_paths:['src/calc.js']},/binary/);
  bad({patch:good+'old mode 100644\nnew mode 100755\n',
    allowed_paths:['src/calc.js']},/mode/);
  bad({patch:good.replace('diff --git a/src/calc.js b/src/calc.js',
    'diff --git a/src/calc.js b/../escape'),allowed_paths:['src/calc.js']},/unsupported rename/);
  bad({patch:good+'x'.repeat(260000),allowed_paths:['src/calc.js']},/oversized/);
  bad({patch:good+good,allowed_paths:['src/calc.js']},/uniquely authorized/);
  bad({patch:good.replace('--- a/src/calc.js','--- /dev/null'),
    allowed_paths:['src/calc.js']},/old path/);
  bad({patch:good.replace('+++ b/src/calc.js','+++ b/gates/security.sh'),
    allowed_paths:['src/calc.js']},/new path/);
  const gate=modifyPatch('gates/security.sh','#!/bin/sh\nexit 0\n');
  bad({patch:gate,allowed_paths:['gates/security.sh']},/unsafe or protected/);
  const workflow=modifyPatch('.github/workflows/ci.yml','name: weakened\n');
  bad({patch:workflow,allowed_paths:['.github/workflows/ci.yml']},/unsafe or protected/);
  bad({patch:good,allowed_paths:['src/link']},/uniquely authorized/);
  fs.unlinkSync(path.join(repo,'src/link'));
  fs.symlinkSync('/etc',path.join(repo,'src/link'));
  const linkPatch=git(['diff','--','src/link'])+'\n';
  git(['checkout','--','src/link']);
  bad({patch:linkPatch,allowed_paths:['src/link']},/nonregular authorized file/);
  const addFile=path.join(repo,'src','addition.js');
  fs.writeFileSync(addFile,'add\n');
  git(['add','src/addition.js']);
  const added=git(['diff','--cached','--','src/addition.js'])+'\n';
  git(['reset','-q','HEAD','--','src/addition.js']);fs.unlinkSync(addFile);
  bad({patch:added,allowed_paths:['src/addition.js']},/mode/);
  assert.throws(()=>validPublisherFile('scripts/lib/agent/outbox.mjs'),/unsafe or protected/);
  assert.throws(()=>validPublisherFile('src/../etc/passwd'),/unsafe or protected/);
  assert.throws(()=>validPublisherFile('src/.env'),/unsafe or protected/);
  put('src/calc.js','dirty\n');
  bad({patch:good,allowed_paths:['src/calc.js']},/dirty/);
  git(['checkout','--','src/calc.js']);
  console.log('Agent publisher preflight: exact-SHA, isolated apply, protected paths, symlink/mode/replay fixtures passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
