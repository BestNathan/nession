#!/usr/bin/env node
// #4160: source-pinned, single-tool catalog selector. No registry access and no arbitrary command input.
import assert from 'node:assert/strict';
import { readdirSync, lstatSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const COMMIT=/^[a-f0-9]{40}$/;
const COMPONENT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
function valid(v) { return COMPONENT.test(v) && !v.includes('..') && v !== '.' && v !== '..'; }
function recipe(root,tool,version) {
  if (!valid(tool)||!valid(version)) throw Error('unsafe tool/version selector');
  const path=join(root,tool,version,'build.sh');
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('missing regular build.sh: '+tool+'/'+version);
  return path;
}
function catalog(root) {
  const result=[];
  for (const tool of readdirSync(root,{withFileTypes:true}).filter(x=>x.isDirectory())) {
    if (tool.name==='.github' || tool.name==='.git') continue;
    if (!valid(tool.name)) throw Error('invalid tool directory');
    for (const version of readdirSync(join(root,tool.name),{withFileTypes:true}).filter(x=>x.isDirectory())) {
      if (!valid(version.name)) throw Error('invalid version directory');
      recipe(root,tool.name,version.name);
      result.push({tool:tool.name,version:version.name});
    }
  }
  return result.sort((a,b)=> (a.tool+'/'+a.version).localeCompare(b.tool+'/'+b.version));
}

function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
    env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/nonexistent',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
// Only the exact orphan commit's changed version scripts become auto candidates.
// The caller pins the checkout to that SHA; README and historical deletions never
// schedule a release. The GHCR fingerprint probe independently rejects stale,
// absent or incomplete OCI objects, including replayed change signals.
function changed(root,sourceSha){
  if(!COMMIT.test(sourceSha)||git(root,'rev-parse','HEAD')!==sourceSha)
    throw Error('stale or forged orphan source SHA');
  const parents=git(root,'rev-list','--parents','-n','1',sourceSha).split(/\\s+/).slice(1);
  if(parents.length>1)throw Error('merge commits forbidden in orphan change scanner');
  if(parents.length===0)return catalog(root);
  if(!COMMIT.test(parents[0]))throw Error('invalid parent');
  const output=git(root,'diff-tree','--no-commit-id','--name-only','-r',parents[0],sourceSha);
  const entries=new Map();
  for(const file of output.split('\\n').filter(Boolean)){
    const m=/^([^/]+)\\/([^/]+)\\/build\\.sh$/.exec(file);
    if(!m)continue; // unrelated or deleted artifacts have no release side effect
    const [,tool,version]=m;
    if(!valid(tool)||!valid(version))throw Error('malformed changed recipe selector');
    const script=join(root,tool,version,'build.sh');
    if(!existsSync(script))continue; // deletion preserves previously published OCI history
    recipe(root,tool,version);
    entries.set(tool+'/'+version,{tool,version});
  }
  return [...entries.values()].sort((a,b)=>(a.tool+'/'+a.version).localeCompare(b.tool+'/'+b.version));
}
function targets(root,tool,version,platform='all',arch='all') {
  const script=recipe(root,tool,version);
  const output=execFileSync('bash',[script,'targets'],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/nonexistent'}});
  const lines=output.trim().split('\n').filter(Boolean);
  if (!lines.length || lines.length>12 || new Set(lines).size !== lines.length) throw Error('empty/duplicate/unbounded targets');
  const supported=lines.map(s=>{
    if (!/^(linux)\/(amd64|arm64)$/.test(s)) throw Error('unsupported target: '+s);
    const [os,cpu]=s.split('/');
    return {platform:os,arch:cpu,target:os+'-'+cpu};
  });
  const selected=supported.filter(x=>(platform==='all'||x.platform===platform)&&(arch==='all'||x.arch===arch));
  if (!selected.length) throw Error('requested target not supported');
  return {targets:selected,all_supported: selected.length===supported.length, list:lines, target_csv:selected.map(x=>x.platform+'/'+x.arch).join(',')};
}
function selfTest() {
  const root=mkdtempSync(join(tmpdir(),'catalog-4160-'));
  try {
    assert.equal(catalog(root).length,0);
    assert.throws(()=>recipe(root,'../bad','1'),/unsafe/);
    assert.throws(()=>recipe(root,'jq','latest'),/missing/);
    mkdirSync(join(root,'jq','1.0'),{recursive:true});
    writeFileSync(join(root,'jq','1.0','build.sh'),'#!/bin/bash\nif [ "$1" = targets ]; then printf "linux/amd64\\nlinux/arm64\\n"; fi\n');
    mkdirSync(join(root,'.git'));
    mkdirSync(join(root,'.github','workflows'),{recursive:true});
    assert.deepEqual(catalog(root),[{tool:'jq',version:'1.0'}]);
    assert.equal(targets(root,'jq','1.0','linux','arm64').target_csv,'linux/arm64');
    assert.equal(targets(root,'jq','1.0').all_supported,true);
    assert.equal(targets(root,'jq','1.0','linux','amd64').all_supported,false);
    assert.throws(()=>targets(root,'jq','1.0','darwin'),/not supported/);
    writeFileSync(join(root,'jq','1.0','build.sh'),'#!/bin/bash\nprintf "linux/amd64\\nlinux/amd64\\n"\n');
    assert.throws(()=>targets(root,'jq','1.0'),/duplicate/);
    // Model immutable source/parent semantics using local Git fixtures:
    // initial catalog, unrelated README no-op, script change, deletion, restore,
    // repeated source, forged SHA and wrong ref all have stable decisions.
    const work=join(root,'orphan');
    mkdirSync(work,{recursive:true});
    git(work,'init','-q');
    const commit=message=>{git(work,'add','-A');git(work,'-c','user.name=fixture',
      '-c','user.email=fixture@example.invalid','commit','-qm',message);return git(work,'rev-parse','HEAD');};
    mkdirSync(join(work,'jq','1.8.1'),{recursive:true});
    mkdirSync(join(work,'gh','2.105.0'),{recursive:true});
    writeFileSync(join(work,'jq','1.8.1','build.sh'),'#!/bin/bash\\nprintf "linux/amd64\\\\n"\\n');
    writeFileSync(join(work,'gh','2.105.0','build.sh'),'#!/bin/bash\\nprintf "linux/amd64\\\\n"\\n');
    const initial=commit('first scripts');
    assert.deepEqual(changed(work,initial),[{tool:'gh',version:'2.105.0'},{tool:'jq',version:'1.8.1'}]);
    writeFileSync(join(work,'README.md'),'unrelated update\\n');
    const unrelated=commit('readme only');
    assert.deepEqual(changed(work,unrelated),[]);
    assert.deepEqual(changed(work,unrelated),[],'replay of unaffected source stays no-op');
    writeFileSync(join(work,'jq','1.8.1','build.sh'),'#!/bin/bash\\nprintf "linux/arm64\\\\n"\\n');
    const modified=commit('change jq');
    assert.deepEqual(changed(work,modified),[{tool:'jq',version:'1.8.1'}]);
    assert.throws(()=>changed(work,initial),/stale or forged/);
    assert.throws(()=>changed(work,'0'.repeat(40)),/stale or forged/);
    assert.throws(()=>changed(work,'refs/heads/main'),/stale or forged/);
    rmSync(join(work,'jq','1.8.1','build.sh'));
    const deleted=commit('delete jq');
    assert.deepEqual(changed(work,deleted),[]);
    writeFileSync(join(work,'jq','1.8.1','build.sh'),'#!/bin/bash\\nprintf "linux/amd64\\\\n"\\n');
    const restored=commit('restore jq');
    assert.deepEqual(changed(work,restored),[{tool:'jq',version:'1.8.1'}]);

  } finally {rmSync(root,{recursive:true,force:true});}
  process.stdout.write('catalog-plan deterministic selectors and targets: PASS\n');
}
const [mode,rootArg,...args]=process.argv.slice(2);
if(mode==='self-test') selfTest();
else if(mode==='discover') {
  const root=resolve(rootArg);
  const [intent,tool,version]=args;
  if(!['all','one','changed'].includes(intent)) throw Error('intent must be all, one or changed');
  const entries=intent==='all'?catalog(root):intent==='changed'?changed(root,tool):[ (recipe(root,tool,version),{tool,version}) ];
  process.stdout.write(JSON.stringify({include:entries})+'\n');
} else if(mode==='targets') {
  const root=resolve(rootArg);
  const [tool,version,platform='all',arch='all']=args;
  process.stdout.write(JSON.stringify(targets(root,tool,version,platform,arch))+'\n');
} else {
  throw Error('usage: catalog-plan.mjs self-test | discover CATALOG_ROOT all|one|changed [tool|source_sha version] | targets CATALOG_ROOT tool version [platform|all arch|all]');
}
