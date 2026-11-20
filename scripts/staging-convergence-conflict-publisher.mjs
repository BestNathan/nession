#!/usr/bin/env node
// #4140: credentialed Publisher for a pre-existing Issue and a model result.
// This is trusted-main script only. Never execute Agent/PR checkout code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const REPO='BestNathan/nession';
const SHA=/^[0-9a-f]{40}$/;
const MAX_PATCH=256*1024;
const BLOCKED=/^(?:\.github\/|\.git(?:\/|$)|gates\/|AGENTS\.md$|(?:.*\/)?AGENTS\.md$|(?:.*\/)?\.env(?:\.|$)|(?:.*\/)?(?:id_rsa|id_ed25519)$)/;
function reject(msg){throw Error('trusted conflict Publisher: '+msg);}
function check(v,msg){if(!v)reject(msg);}
function command(bin,args,{cwd,env,stdin,conflict=false}={}){
  const r=spawnSync(bin,args,{cwd,env:{...process.env,...env},
    input:stdin,encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.error)throw r.error;
  if(r.status!==0&&!(conflict&&r.status===1))
    reject(bin+' '+args[0]+' failed status='+r.status+' '+(r.stderr||'').slice(0,500));
  return r;
}
function git(args,opts={}){return command('git',args,opts).stdout.trim();}
function gh(token,method,endpoint,body=null){
  check(token&&typeof token==='string','missing scoped GitHub credential');
  const args=['api','--method',method,'repos/'+REPO+'/'+endpoint];
  if(body!==null)args.push('--input','-');
  const raw=command('gh',args,{env:{GH_TOKEN:token},stdin:body===null?undefined:JSON.stringify(body)}).stdout;
  try{return JSON.parse(raw)}catch{reject('invalid GitHub '+method+' response for '+endpoint)}
}
export function allowedConflictPath(p){
  return typeof p==='string'&&p.length>0&&p.length<=230&&
    !p.startsWith('/')&&!p.split('/').some(s=>!s||s==='.'||s==='..')&&
    !BLOCKED.test(p)&&!p.includes('\0')&&!p.includes('\n')&&!p.includes('\t')&&
    !p.includes('\\');
}
function conflictIndex(target,source){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-verified-repair-'));
  const wt=path.join(dir,'checkout');
  try{
    git(['worktree','add','--detach',wt,target]);
    const result=command('git',['-c','user.name=Nession Merge','-c',
      'user.email=nession-merge@users.noreply.github.com',
      'merge','--no-commit','--no-ff',source],{cwd:wt,conflict:true});
    check(result.status===1,'pinned Git pair did not conflict in a real worktree');
    const unmerged=git(['ls-files','-u','-z'],{cwd:wt}).split('\0').filter(Boolean);
    const paths=[...new Set(unmerged.map(entry=>{
      const m=/^(100644|100755) [a-f0-9]{40} [123]\t(.+)$/.exec(entry);
      check(m&&allowedConflictPath(m[2]),'unsupported or privileged conflict entry');
      return m[2];
    }))];
    check(paths.length>0&&paths.length<=32,'unbounded or empty conflict paths');
    return paths.sort();
  }finally{
    try{git(['worktree','remove','--force',wt])}catch{}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
function mergeTree(target,source){
  const r=command('git',['merge-tree','--write-tree',target,source],{conflict:true});
  const sha=r.stdout.split('\n')[0];
  check(SHA.test(sha),'invalid Git merge-tree SHA');
  return {sha,conflict:r.status===1};
}
function candidateInput(file,mode,main,lane){
  check(['source-repair','direct-integration'].includes(mode),'invalid task mode');
  const info=JSON.parse(fs.readFileSync(path.join(file,'candidate.json'),'utf8'));
  const patch=fs.readFileSync(path.join(file,'candidate.patch'));
  check(patch.length>0&&patch.length<=MAX_PATCH,'missing or oversized Agent patch');
  check(info?.schema_version===1&&info.mode===mode&&
    info.target_sha===lane&&info.source_sha===main&&
    SHA.test(info.auto_tree??'')&&SHA.test(info.resolved_tree??'')&&
    SHA.test(info.candidate_tree??'')&&SHA.test(info.commit_sha??'')&&
    info.authoritative===false,'foreign candidate or forged source identity');
  check(Array.isArray(info.conflict_paths)&&info.conflict_paths.length>0&&
    info.conflict_paths.length<=32&&
    info.conflict_paths.every(allowedConflictPath),
    'unbounded or forbidden Agent conflict paths');
  const auto=mergeTree(lane,main);
  check(auto.conflict&&auto.sha===info.auto_tree,'candidate stale Git merge-tree');
  const actual=conflictIndex(lane,main);
  check(JSON.stringify(actual)===JSON.stringify([...info.conflict_paths].sort()),
    'Agent conflict-path set differs from Git index');
  const parentShas=mode==='source-repair'?[lane]:[lane,main];
  check(JSON.stringify(parentShas)===JSON.stringify(info.parents),
    'wrong candidate Git ancestry');
  const baseTree=mode==='source-repair'
    ?git(['rev-parse',lane+'^{tree}']):auto.sha;
  const index=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'nession-repair-index-')),'index');
  try{
    const env={GIT_INDEX_FILE:index};
    git(['read-tree',baseTree],{env});
    command('git',['apply','--cached','--binary','-'],{env,stdin:patch});
    const tree=git(['write-tree'],{env});
    check(tree===info.candidate_tree,'Agent patch did not reproduce candidate tree');
    const changed=git(['diff','--name-only','-z',baseTree,tree]).split('\0').filter(Boolean);
    check(changed.length>0&&changed.every(p=>actual.includes(p)),
      'Agent patch modifies a nonconflicting file');
    // Git sees the entire candidate tree. Protected workflow files can change
    // even as clean auto-merged paths; never authorize that with a PR writer.
    check(!git(['diff','--name-only','-z',lane,tree,'--','.github/workflows'])
      .split('\0').filter(Boolean).length,
      'candidate requires separate workflow-file App permission (#4059)');
    for(const p of actual){
      const data=command('git',['show',tree+':'+p]).stdout;
      check(!data.includes('\0')&&Buffer.byteLength(data)<128*1024&&
        !/^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(data),
        'unsafe conflict resolution bytes');
    }
    check(command('git',['diff','--check',baseTree,tree]).stdout==='',
      'invalid candidate whitespace or patch');
    if(mode==='source-repair'){
      const virtual=git(['-c','user.name=Nession Merge','-c',
        'user.email=nession-merge@users.noreply.github.com',
        'commit-tree',tree,'-p',lane,'-m','verify source repair']);
      const replay=mergeTree(virtual,main);
      check(!replay.conflict&&replay.sha===info.resolved_tree,
        'source repair does not replay to resolved Git tree');
    }else{
      check(tree===info.resolved_tree,'integration candidate altered source tree');
    }
    return {tree,parents:parentShas,paths:actual};
  }finally{fs.rmSync(path.dirname(index),{recursive:true,force:true})}
}
function identity(mode,branch,main,lane){
  check(typeof branch==='string'&&/^[A-Za-z][A-Za-z0-9._/-]{0,65}$/.test(branch)&&
    !branch.split('/').some(x=>!x||x==='.'||x==='..')&&
    SHA.test(main)&&SHA.test(lane)&&main!==lane,'invalid immutable refs');
  return 'fix/convergence-conflict-'+branch.replace(/[^a-zA-Z0-9-]/g,'-')+
    '-'+main.slice(0,12)+'-'+lane.slice(0,12)+'-'+(mode==='source-repair'?'a':'b');
}
export function verifyUpstream(pr,issue,{branch,main,lane,mode,repairIssue}){
  const marker='<!-- nession-agent-conflict-repair:v1 lane='+branch+
    ' main='+main+' target='+lane+' -->';
  check(pr?.state==='open'&&pr.draft===false&&
    pr.user?.login==='nession-publisher[bot]'&&
    pr.body?.startsWith('Staging Convergence automated proposal')&&
    pr.head?.ref==='main'&&pr.head?.sha===main&&
    pr.base?.ref===branch&&
    pr.head?.repo?.full_name===REPO&&pr.base?.repo?.full_name===REPO&&
    pr.mergeable_state==='dirty','untrusted or no-longer-conflicting native source PR');
  check(issue?.number===repairIssue&&issue.state==='open'&&
    !issue.pull_request&&issue.body?.includes(marker)&&
    issue.labels?.some(x=>x.name==='status:in-progress')&&
    (issue.labels??[]).some(x=>x.name==='bug')&&
    ['source-repair','direct-integration'].includes(mode),
    'Issue-first verified repair identity absent or unsupported mode');
}
async function main(){
  if(process.argv[2]==='self-test'){
    assert.equal(allowedConflictPath('crates/nession-agent/src/lib.rs'),true);
    for(const p of ['../README.md','.github/workflows/x.yml','gates/x',
      'AGENTS.md','src/AGENTS.md','a/.env','a/../x','a\\b','./x'])
      assert.equal(allowedConflictPath(p),false,p);
    assert.throws(()=>identity('source-repair','../evil','a'.repeat(40),'b'.repeat(40)));
    assert.match(identity('direct-integration','staging','a'.repeat(40),'b'.repeat(40)),
      /-b$/);
    assert.throws(()=>verifyUpstream({}, {}, {branch:'staging',main:'a'.repeat(40),
      lane:'b'.repeat(40),mode:'source-repair',repairIssue:123}),/untrusted/);

    // Real Git contract: reconstruct both model-proof candidate types from the
    // original binary-capable patch in a SEPARATE trusted index, not from JSON.
    const oldCwd=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-publisher-selftest-'));
    const proofCli=path.join(oldCwd,'scripts/merge-conflict-resolution-probe.mjs');
    try{
      process.chdir(root);
      git(['init','-q','-b','main']);
      git(['config','user.name','Nession Fixture']);
      git(['config','user.email','nession-fixture@example.com']);
      fs.writeFileSync('conflict.txt','policy=base\n');
      git(['add','.']);git(['commit','-qm','base']);
      const base=git(['rev-parse','HEAD']);
      fs.writeFileSync('conflict.txt','policy=source\n');
      git(['commit','-qam','source']);
      const source=git(['rev-parse','HEAD']);
      git(['checkout','-q','-b','lane',base]);
      fs.writeFileSync('conflict.txt','policy=target\n');
      git(['commit','-qam','lane']);
      const lane=git(['rev-parse','HEAD']);
      for(const mode of ['source-repair','direct-integration']){
        const dir=path.join(root,mode);
        fs.mkdirSync(dir);
        const worktree=path.join(dir,'worktree'),ctx=path.join(dir,'context.json');
        command('node',[proofCli,'prepare',root,lane,source,worktree,ctx]);
        fs.writeFileSync(path.join(worktree,'conflict.txt'),mode==='source-repair'
          ?'policy=source\n':'policy=target\npolicy=source\n');
        command('node',[proofCli,'finalize',root,ctx,mode,path.join(dir,'candidate')]);
        const proved=candidateInput(path.join(dir,'candidate'),mode,source,lane);
        assert.deepEqual(proved.parents,mode==='source-repair'?[lane]:[lane,source]);
        assert.deepEqual(proved.paths,['conflict.txt']);
        assert.match(proved.tree,SHA);
        const candidatePath=path.join(dir,'candidate','candidate.json');
        const original=fs.readFileSync(candidatePath,'utf8');
        const damaged=JSON.parse(original);damaged.candidate_tree='0'.repeat(40);
        fs.writeFileSync(candidatePath,JSON.stringify(damaged));
        assert.throws(()=>candidateInput(path.join(dir,'candidate'),mode,source,lane),
          /did not reproduce candidate tree/);
        fs.writeFileSync(candidatePath,original);
      }
    }finally{process.chdir(oldCwd);fs.rmSync(root,{recursive:true,force:true})}
    console.log('trusted conflict Publisher: identity, path policy and refusal fixtures PASS');
    return;
  }
  check(['preflight','publish'].includes(process.argv[2])&&process.argv[3],
    'usage: self-test | preflight CANDIDATE_DIR | publish CANDIDATE_DIR');
  check(process.env.GITHUB_REPOSITORY===REPO&&process.env.GITHUB_REF==='refs/heads/main'&&
    process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&
    Number(process.env.GITHUB_RUN_ATTEMPT)===1,
    'not a trusted main-owned first-attempt dispatch');
  const {BRANCH:branch,MAIN_SHA:main,LANE_SHA:lane,REPAIR_MODE:mode,
    SOURCE_PR_NUMBER:rawPr,REPAIR_ISSUE_NUMBER:rawIssue,GH_TOKEN:token}=process.env;
  const repairIssue=Number(rawIssue),sourcePr=Number(rawPr);
  check(Number.isSafeInteger(sourcePr)&&sourcePr>0&&
    Number.isSafeInteger(repairIssue)&&repairIssue>0,'invalid Issue/source PR');
  const branchRef=identity(mode,branch,main,lane);
  const [pr,issue,currentMain,currentLane]=[
    gh(token,'GET','pulls/'+sourcePr),
    gh(token,'GET','issues/'+repairIssue),
    gh(token,'GET','git/ref/heads/main'),
    gh(token,'GET','git/ref/heads/'+branch),
  ];
  verifyUpstream(pr,issue,{branch,main,lane,mode,repairIssue});
  check(currentMain.object?.sha===main&&currentLane.object?.sha===lane,
    'source ref moved before Candidate validation');
  const candidate=candidateInput(process.argv[3],mode,main,lane);
  if(process.argv[2]==='preflight'){
    console.log(JSON.stringify({status:'source_verified',mode,issue:repairIssue,
      source_pr:sourcePr,tree:candidate.tree,parents:candidate.parents,
      no_protected_mutation:true}));
    return;
  }
  const found=gh(token,'GET','pulls?state=all&head=BestNathan:'+
    encodeURIComponent(branchRef)+'&per_page=100');
  check(Array.isArray(found)&&found.length===0,
    'candidate already published; reconcile without retry');
  const remote=command('git',['ls-remote','origin','refs/heads/'+branchRef]).stdout.trim();
  check(remote==='','candidate branch exists; refuse overwrite');
  const commit=git(['-c','user.name=Nession Repair Publisher','-c',
    'user.email=nession-repair@users.noreply.github.com','commit-tree',candidate.tree,
    ...candidate.parents.flatMap(p=>['-p',p]),'-m',
    'fix(agent): source-bound '+mode+' convergence repair (Issue #'+repairIssue+')']);
  const verifyMain=gh(token,'GET','git/ref/heads/main');
  const verifyLane=gh(token,'GET','git/ref/heads/'+branch);
  check(verifyMain.object?.sha===main&&verifyLane.object?.sha===lane,
    'source ref moved before publication');
  const header='AUTHORIZATION: basic '+
    Buffer.from('x-access-token:'+token,'utf8').toString('base64');
  command('git',['push','https://github.com/'+REPO+'.git',
    commit+':refs/heads/'+branchRef],{env:{
      GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0:header,
    }});
  const pushed=gh(token,'GET','git/ref/heads/'+branchRef);
  check(pushed.object?.sha===commit,'push ref cannot be authenticated');
  const created=gh(token,'POST','pulls',{
    title:'fix(agent): '+branch+' '+mode+' conflict repair (#'+repairIssue+')',
    body:'Refs #'+repairIssue+'\n\nAgent-assisted conflict resolution draft. Source Convergence PR #'+
      sourcePr+'; original main '+main+' and target '+lane+
      '. This candidate has not passed independent Quality/Acceptance; never auto-merge.',
    head:branchRef,base:branch,draft:true,
  });
  const read=gh(token,'GET','pulls/'+created.number);
  const publishedCommit=gh(token,'GET','git/commits/'+commit);
  check(read?.draft===true&&read.state==='open'&&
    read.head?.sha===commit&&read.base?.ref===branch&&
    publishedCommit?.tree?.sha===candidate.tree&&
    JSON.stringify((publishedCommit.parents??[]).map(p=>p.sha))===
      JSON.stringify(candidate.parents),'independent PR/tree ancestry readback failed');
  console.log(JSON.stringify({status:'published_draft',issue:repairIssue,
    source_pr:sourcePr,pr:read.number,head:commit,tree:candidate.tree,
    parents:candidate.parents,source_pair:[lane,main]}));
}
main().catch(e=>{console.error(e.stack??String(e));process.exitCode=1});
