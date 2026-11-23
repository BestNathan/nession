#!/usr/bin/env node
// #4124: isolated, source-pinned proof of two Git conflict repair strategies.
// This script never pushes branches, opens PRs, or consumes credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {allowedConflictPath} from './merge-conflict-file-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
function git(cwd, args, {allowConflict=false, env={}}={}) {
  const r=spawnSync('git', args, {cwd, env:{...process.env,...env},encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.error)throw r.error;
  if(r.status!==0 && !(allowConflict&&r.status===1))
    throw Error('git '+args[0]+' failed ('+r.status+'): '+r.stderr?.slice(0,800));
  return r;
}
function validSha(value) {if(!SHA.test(value??''))throw Error('expected pinned full SHA');return value;}
function pathsFromUnmerged(cwd) {
  const raw=git(cwd,['ls-files','-u','-z']).stdout;
  const p=[...new Set(raw.split('\0').filter(Boolean).map(line=>{
    const match=/^(\d+) [a-f0-9]{40} [123]\t([^\0]+)$/.exec(line);
    if(!match||!['100644','100755'].includes(match[1]))throw Error('unsupported merge conflict index entry');
    return match[2];
  }))];
  if(!p.length||p.length>32)throw Error('expected 1..32 ordinary conflict files');
  for(const v of p)if(!allowedConflictPath(v))
    throw Error('unsupported security-sensitive Git conflict path');
  return p;
}
function mergeTree(cwd,a,b) {
  const r=git(cwd,['merge-tree','--write-tree',validSha(a),validSha(b)],{allowConflict:true});
  const tree=r.stdout.split('\n')[0];
  if(!SHA.test(tree))throw Error('missing merge-tree object');
  return {tree,conflict:r.status===1};
}
function prepare(repo,target,source,dir) {
  validSha(target);validSha(source);
  if(!dir||fs.existsSync(dir))throw Error('worktree destination must not exist');
  const auto=mergeTree(repo,target,source);
  if(!auto.conflict)throw Error('input commits do not conflict');
  git(repo,['worktree','add','--detach',dir,target]);
  const merge=git(dir,['-c','merge.conflictStyle=merge','merge','--no-commit','--no-ff',source],{allowConflict:true});
  if(merge.status!==1)throw Error('expected reproducible worktree conflict');
  const conflicts=pathsFromUnmerged(dir);
  return {schema_version:1,target_sha:target,source_sha:source,
    auto_tree:auto.tree,conflict_paths:conflicts,worktree:path.resolve(dir)};
}
// Read-only eligibility preflight for the trusted Controller. Use the same
// actual merge index as the isolated Agent job; never guess from changed paths.
// Always drop the disposable worktree, even after rejecting sensitive files.
export function inspectConflictPaths(repo,target,source){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-conflict-inspect-'));
  const worktree=path.join(root,'worktree');
  try {
    const info=prepare(repo,target,source,worktree);
    return {schema_version:1,target_sha:target,source_sha:source,
      conflict_paths:[...info.conflict_paths].sort(),eligible:true};
  } finally {
    if(fs.existsSync(worktree)){
      git(repo,['worktree','remove','--force',worktree]);
    }
    fs.rmSync(root,{recursive:true,force:true});
  }
}
function pathsFromUnmergedOrEmpty(cwd,env={}){
  const raw=git(cwd,['ls-files','-u','-z'],{env}).stdout;
  return [...new Set(raw.split('\0').filter(Boolean).map(x=>x.split('\t').slice(1).join('\t')))];
}
function finalize(repo,context,mode,outDir) {
  if(!['source-repair','direct-integration'].includes(mode))throw Error('invalid resolution mode');
  if(!context||context.schema_version!==1||!Array.isArray(context.conflict_paths)||
    context.conflict_paths.length<1||context.conflict_paths.length>32)throw Error('invalid context');
  const {target_sha:target,source_sha:source,auto_tree:auto,conflict_paths:conflicts,worktree:dir}=context;
  validSha(target);validSha(source);validSha(auto);
  if(!dir||!fs.existsSync(dir)||git(dir,['rev-parse','HEAD']).stdout.trim()!==target ||
     git(dir,['rev-parse','MERGE_HEAD']).stdout.trim()!==source)throw Error('stale or foreign worktree merge identity');
  const original=mergeTree(repo,target,source);
  if(!original.conflict||original.tree!==auto)throw Error('stale or forged merge-tree identity');
  // Stage in an alternate index. Failed independent validation must NEVER
  // erase stage 1/2/3 conflict entries from the Agent's live worktree:
  // a bounded correction pass needs those exact original Git blob identities.
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'nession-repair-workindex-'));
  const indexFile=path.join(scratch,'index');
  try {
  const originalIndex=git(dir,
    ['rev-parse','--path-format=absolute','--git-path','index']).stdout.trim();
  fs.copyFileSync(originalIndex,indexFile);
  const env={GIT_INDEX_FILE:indexFile};
  const pending=pathsFromUnmergedOrEmpty(dir,env);
  if(!pending.every(p=>conflicts.includes(p)))throw Error('conflict set changed');
  git(dir,['add','--',...conflicts],{env});
  const untracked=git(dir,['ls-files','--others','--exclude-standard','-z'],{env}).stdout.split('\0').filter(Boolean);
  const unstaged=git(dir,['diff','--name-only','-z'],{env}).stdout.split('\0').filter(Boolean);
  if([...untracked,...unstaged].some(p=>!conflicts.includes(p)))throw Error('Agent modified non-conflicting paths');
  if(git(dir,['ls-files','-u','-z'],{env}).stdout)throw Error('unmerged files remain');
  for(const p of conflicts) {
    if(!fs.existsSync(path.join(dir,p)))throw Error('pilot requires text-file resolution');
    const content=fs.readFileSync(path.join(dir,p),'utf8');
    if(/^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(content))throw Error('unresolved conflict marker');
  }
  const staged=git(dir,['diff','--cached','--check'],{allowConflict:true,env});
  if(staged.status!==0)throw Error('resolved changes failed whitespace check');
  const tree=validSha(git(dir,['write-tree'],{env}).stdout.trim());
  const changed=git(dir,['diff','--name-only','-z',auto,tree]).stdout.split('\0').filter(Boolean);
  if(changed.some(p=>!conflicts.includes(p)))throw Error('resolution modified clean merged paths');
  if(!changed.length)throw Error('resolution made no change');
  let candidateTree=tree,commit,patchBase=auto;
  if(mode==='source-repair') {
    const indexFile=path.join(os.tmpdir(),'nession-conflict-index-'+process.pid+'-'+Date.now());
    try {
      const candidateEnv={GIT_INDEX_FILE:indexFile};
      git(repo,['read-tree',target],{env:candidateEnv});
      for(const p of conflicts) {
        // Worktree's resolved stage-0 blob is in the FIRST scratch index.
        // The candidate index starts as untouched TARGET and must never be
        // mistaken for the resolved source blob.
        const entry=git(dir,['ls-files','-s','--',p],{env}).stdout.trim();
        const match=/^(100644|100755) ([a-f0-9]{40}) 0\t/.exec(entry);
        if(!match)throw Error('invalid resolved source blob');
        git(repo,['update-index','--add','--cacheinfo',match[1]+','+match[2]+','+p],{env:candidateEnv});
      }
      candidateTree=validSha(git(repo,['write-tree'],{env:candidateEnv}).stdout.trim());
    } finally {fs.rmSync(indexFile,{force:true});}
    if(candidateTree===git(repo,['rev-parse',target+'^{tree}']).stdout.trim())
      throw Error('source repair is empty');
    commit=validSha(git(repo,['-c','user.name=Nession Probe','-c','user.email=probe@users.noreply.github.com',
      'commit-tree',candidateTree,'-p',target,'-m','test: verified source repair']).stdout.trim());
    const replay=mergeTree(repo,commit,source);
    if(replay.conflict||replay.tree!==tree)throw Error('source repair did not reproduce the resolved merge tree');
    patchBase=git(repo,['rev-parse',target+'^{tree}']).stdout.trim();
  } else {
    commit=validSha(git(repo,['-c','user.name=Nession Probe','-c','user.email=probe@users.noreply.github.com',
      'commit-tree',tree,'-p',target,'-p',source,'-m','test: verified direct integration']).stdout.trim());
  }
  const parents=git(repo,['show','-s','--format=%P',commit]).stdout.trim().split(' ');
  const expected=mode==='source-repair'?[target]:[target,source];
  if(JSON.stringify(parents)!==JSON.stringify(expected)||
     git(repo,['rev-parse',commit+'^{tree}']).stdout.trim()!==candidateTree)
    throw Error('candidate ancestry or tree mismatch');
  const patch=git(repo,['diff','--binary',patchBase,candidateTree]).stdout;
  const report={schema_version:1,mode,target_sha:target,source_sha:source,
    auto_tree:auto,resolved_tree:tree,candidate_tree:candidateTree,
    commit_sha:commit,parents,conflict_paths:conflicts,authoritative:false};
  if(outDir){fs.mkdirSync(outDir,{recursive:true});
    fs.writeFileSync(path.join(outDir,'candidate.json'),JSON.stringify(report,null,2)+'\n');
    fs.writeFileSync(path.join(outDir,'candidate.patch'),patch);}
  return report;
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
}
function testFixture(root){
  const repo=path.join(root,'repo');fs.mkdirSync(repo);
  git(repo,['init','-q','-b','main']);
  git(repo,['config','user.name','Nession Test']);git(repo,['config','user.email','test@example.com']);
  fs.writeFileSync(path.join(repo,'conflict.txt'),'policy=base\n');
  fs.writeFileSync(path.join(repo,'clean.txt'),'clean=base\n');
  git(repo,['add','.']);git(repo,['commit','-qm','base']);
  const base=git(repo,['rev-parse','HEAD']).stdout.trim();
  fs.writeFileSync(path.join(repo,'conflict.txt'),'policy=main\n');
  fs.writeFileSync(path.join(repo,'clean.txt'),'clean=main\n');
  // A clean source-only workflow change is NOT an unsafe conflict path.
  fs.mkdirSync(path.join(repo,'.github','workflows'),{recursive:true});
  fs.writeFileSync(path.join(repo,'.github','workflows','source.yml'),'name: source\n');
  git(repo,['add','.']);git(repo,['commit','-qm','main']);const source=git(repo,['rev-parse','HEAD']).stdout.trim();
  git(repo,['checkout','-q','-b','lane',base]);
  fs.writeFileSync(path.join(repo,'conflict.txt'),'policy=lane\n');
  fs.writeFileSync(path.join(repo,'lane.txt'),'lane-only\n');
  git(repo,['add','.']);git(repo,['commit','-qm','lane']);
  return {repo,target:git(repo,['rev-parse','HEAD']).stdout.trim(),source};
}
function selfTest(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-conflict-probe-'));
  try {
    const f=testFixture(root);
    // A blocked workflow path produces no eligible report or leaked worktree.
    const blockedRepo=path.join(root,'blocked');
    fs.mkdirSync(blockedRepo);
    git(blockedRepo,['init','-q','-b','main']);
    git(blockedRepo,['config','user.name','Nession Test']);
    git(blockedRepo,['config','user.email','test@example.com']);
    fs.mkdirSync(path.join(blockedRepo,'.github','workflows'),{recursive:true});
    const wf=path.join(blockedRepo,'.github','workflows','ci.yml');
    fs.writeFileSync(wf,'name: base\n');
    git(blockedRepo,['add','.']);git(blockedRepo,['commit','-qm','base']);
    const blockedBase=git(blockedRepo,['rev-parse','HEAD']).stdout.trim();
    fs.writeFileSync(wf,'name: source\n');
    git(blockedRepo,['commit','-qam','source']);
    const blockedSource=git(blockedRepo,['rev-parse','HEAD']).stdout.trim();
    git(blockedRepo,['checkout','-q','-b','lane',blockedBase]);
    fs.writeFileSync(wf,'name: target\n');
    git(blockedRepo,['commit','-qam','target']);
    const blockedTarget=git(blockedRepo,['rev-parse','HEAD']).stdout.trim();
    assert.throws(()=>inspectConflictPaths(blockedRepo,blockedTarget,blockedSource),
      /unsupported security-sensitive Git conflict path/);
    assert.doesNotMatch(git(blockedRepo,['worktree','list','--porcelain']).stdout,
      /nession-conflict-inspect-/);
    assert.equal(mergeTree(f.repo,f.target,f.source).conflict,true);
    assert.deepEqual(inspectConflictPaths(f.repo,f.target,f.source),{
      schema_version:1,target_sha:f.target,source_sha:f.source,
      conflict_paths:['conflict.txt'],eligible:true,
    });
    // Verify the normal repository worktree is unchanged by inspection.
    assert.equal(git(f.repo,['worktree','list','--porcelain']).stdout.includes(
      'nession-conflict-inspect-'),false);
    const a=prepare(f.repo,f.target,f.source,path.join(root,'a'));
    assert.throws(()=>finalize(f.repo,a,'source-repair',null),/unresolved conflict marker/);
    fs.writeFileSync(path.join(a.worktree,'conflict.txt'),'policy=both\n');
    assert.throws(()=>finalize(f.repo,a,'source-repair',null),/source repair did not reproduce/);
    // A rejected source replay must leave the three-way Git index intact;
    // the correction Agent can still read BASE/OURS/THEIRS at exact SHAs.
    assert.notEqual(git(a.worktree,['ls-files','-u','-z']).stdout,'');
    fs.writeFileSync(path.join(a.worktree,'conflict.txt'),'policy=main\n');
    const resultA=finalize(f.repo,a,'source-repair',null);
    assert.deepEqual(resultA.parents,[f.target]);
    assert.equal(mergeTree(f.repo,resultA.commit_sha,f.source).conflict,false);
    const b=prepare(f.repo,f.target,f.source,path.join(root,'b'));
    fs.writeFileSync(path.join(b.worktree,'clean.txt'),'unauthorized\n');
    assert.throws(()=>finalize(f.repo,b,'direct-integration',null),/non-conflicting/);
    fs.writeFileSync(path.join(b.worktree,'clean.txt'),'clean=main\n');
    fs.writeFileSync(path.join(b.worktree,'conflict.txt'),'policy=both\n');
    const resultB=finalize(f.repo,b,'direct-integration',null);
    assert.deepEqual(resultB.parents,[f.target,f.source]);
    assert.equal(git(f.repo,['show',resultB.commit_sha+':clean.txt']).stdout,'clean=main\n');
    assert.equal(git(f.repo,['show',resultB.commit_sha+':lane.txt']).stdout,'lane-only\n');
    assert.throws(()=>finalize(f.repo,{...b,source_sha:f.target},'direct-integration',null),/foreign worktree/);
    console.log('source-repair and direct-integration positive/negative Git closure: PASS');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const command=process.argv[2];
if(command==='self-test')selfTest();
else if(command==='inspect'){
  const [repo,target,source]=process.argv.slice(3);
  console.log(JSON.stringify(inspectConflictPaths(repo,target,source)));
}else if(command==='prepare'){
  const [repo,target,source,dir,output]=process.argv.slice(3);
  const context=prepare(repo,target,source,dir);
  fs.writeFileSync(output,JSON.stringify(context,null,2)+'\n');
  console.log(JSON.stringify(context));
}else if(command==='finalize'){
  const [repo,contextPath,mode,outDir]=process.argv.slice(3);
  console.log(JSON.stringify(finalize(repo,JSON.parse(fs.readFileSync(contextPath,'utf8')),mode,outDir)));
}else throw Error('usage: self-test | inspect <repo> <target_sha> <source_sha> | prepare <repo> <target_sha> <source_sha> <dir> <context.json> | finalize <repo> <context.json> <source-repair|direct-integration> <outdir>');
