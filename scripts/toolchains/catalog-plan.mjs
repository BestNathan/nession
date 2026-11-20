#!/usr/bin/env node
// #4160: source-pinned, single-tool catalog selector. No registry access and no arbitrary command input.
import assert from 'node:assert/strict';
import { readdirSync, lstatSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
    if (!valid(tool.name)) throw Error('invalid tool directory');
    for (const version of readdirSync(join(root,tool.name),{withFileTypes:true}).filter(x=>x.isDirectory())) {
      if (!valid(version.name)) throw Error('invalid version directory');
      recipe(root,tool.name,version.name);
      result.push({tool:tool.name,version:version.name});
    }
  }
  return result.sort((a,b)=> (a.tool+'/'+a.version).localeCompare(b.tool+'/'+b.version));
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
    assert.deepEqual(catalog(root),[{tool:'jq',version:'1.0'}]);
    assert.equal(targets(root,'jq','1.0','linux','arm64').target_csv,'linux/arm64');
    assert.equal(targets(root,'jq','1.0').all_supported,true);
    assert.equal(targets(root,'jq','1.0','linux','amd64').all_supported,false);
    assert.throws(()=>targets(root,'jq','1.0','darwin'),/not supported/);
    writeFileSync(join(root,'jq','1.0','build.sh'),'#!/bin/bash\nprintf "linux/amd64\\nlinux/amd64\\n"\n');
    assert.throws(()=>targets(root,'jq','1.0'),/duplicate/);
  } finally {rmSync(root,{recursive:true,force:true});}
  process.stdout.write('catalog-plan deterministic selectors and targets: PASS\n');
}
const [mode,rootArg,...args]=process.argv.slice(2);
if(mode==='self-test') selfTest();
else if(mode==='discover') {
  const root=resolve(rootArg);
  const [intent,tool,version]=args;
  if(intent!=='all' && intent!=='one') throw Error('intent must be all or one');
  const entries=intent==='all'?catalog(root):[ (recipe(root,tool,version),{tool,version}) ];
  process.stdout.write(JSON.stringify({include:entries})+'\n');
} else if(mode==='targets') {
  const root=resolve(rootArg);
  const [tool,version,platform='all',arch='all']=args;
  process.stdout.write(JSON.stringify(targets(root,tool,version,platform,arch))+'\n');
} else {
  throw Error('usage: catalog-plan.mjs self-test | discover CATALOG_ROOT all|one [tool version] | targets CATALOG_ROOT tool version [platform|all arch|all]');
}
