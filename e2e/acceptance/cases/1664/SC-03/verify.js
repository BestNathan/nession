'use strict';
// Parent #1664 SC-03: authenticated original public Publisher proof only.
// This Case deliberately stays Pending without real Reviewer→repair evidence.
// GitHub and agent-store are read only. No credentials, PR writer or model.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../../../../..');
const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const ACTION='dac10d570c30557fe629b8605ecb44d33335eb967e24a52931467ac7b93b5e31';
const INTENT='workflows/issues/1997/results/39448549052-1-'+ACTION+'.json';
function git(dir,...args) {
  return execFileSync('git',['-C',dir,...args],{
    encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
async function source(endpoint){
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
    headers:{
      Accept:'application/vnd.github+json',
      'User-Agent':'nession-source-aligned-1664-sc03',
      'X-GitHub-Api-Version':'2022-11-28',
      ...(token?{Authorization:'Bearer '+token}:{}),
    },
    signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.status,200,'independent public GitHub '+endpoint+' unavailable');
  return response.json();
}
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target,SHA,'must execute on exact main commit');
  assert.equal(git(root,'rev-parse','HEAD'),target,'Case source checkout SHA drift');
  const m=await import(pathToFileURL(path.join(root,
    'scripts/lib/agent/publisher/publication-readback.mjs')).href);
  execFileSync(process.execPath,[
    'scripts/lib/agent/publisher/publication-readback-selftest.mjs'],{
    cwd:root,timeout:120000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe'],
  });
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'nession-sc03-publication-'));
  try{
    const store=path.join(scratch,'store');
    execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','agent-store','--','https://github.com/'+REPO+'.git',store],{
      timeout:90000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024,
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    const branch=git(store,'symbolic-ref','--short','HEAD');
    assert.equal(branch,'agent-store');
    const tip=git(store,'rev-parse','HEAD');
    assert.match(tip,SHA);
    const committed=git(store,'ls-files','--',INTENT).split('\n').filter(Boolean);
    assert.deepEqual(committed,[INTENT],'Publisher intent must be committed, not untracked');
    const record=JSON.parse(git(store,'show','HEAD:'+INTENT));
    const commitSha=git(store,'log','-1','--format=%H','HEAD','--',INTENT);
    assert.match(commitSha,SHA);
    git(store,'merge-base','--is-ancestor',commitSha,tip);
    const state=JSON.parse(git(store,'show','HEAD:workflows/issues/1997/states/00000016.json'));
    assert.equal(state.version,16);
    const action=state.outbox.filter(x=>x.id===ACTION);
    assert.equal(action.length,1);
    assert.equal(action[0].status,'yielded');
    assert.equal(action[0].receipt.source_run_id,39448549052);
    assert.equal(action[0].receipt.checkpoint_version,3);
    const [
      sourceRun,sourceJobs,ownerComment,pullRequest,branchRef,
      pullCommits,originalCommit,originalDiff,currentFiles,branchPulls,
    ]=await Promise.all([
      source('actions/runs/39609600546'),
      source('actions/runs/39609600546/jobs?per_page=100'),
      source('issues/comments/6308823032'),
      source('pulls/2176'),
      source('git/ref/heads/agent/1997/developer-checkpoint-v3'),
      source('pulls/2176/commits?per_page=100'),
      source('git/commits/3d8e3807cc01f6082734b8d0ba458217c28f60a4'),
      source('commits/3d8e3807cc01f6082734b8d0ba458217c28f60a4'),
      source('pulls/2176/files?per_page=100'),
      source('pulls?state=all&head=BestNathan%3Aagent%2F1997%2Fdeveloper-checkpoint-v3&per_page=100'),
    ]);
    assert.ok(Array.isArray(originalDiff.files));
    const verified=m.verifyControlledOriginalPublication({
      sourceRun,sourceJobs,ownerComment,intent:record,pullRequest,
      branchRef,pullCommits,originalCommit,originalFiles:originalDiff.files,
      currentFiles,branchPulls,
    });
    assert.equal(verified.status,'original_pr_verified_not_reviewed');
    assert.equal(verified.original_pr,2176);
    assert.equal(verified.original_pr_sha,
      '3d8e3807cc01f6082734b8d0ba458217c28f60a4');
    const result={
      status:'pending',
      summary:'Real first Publisher, exact Store write-ahead CAS, original PR/one-file Git SHA and replay negatives verified. Native Reviewer changes_requested, same Developer repair and SHA B Acceptance are still required by SC-03.',
      evidence:[
        {type:'runtime',value:'exact Case/main SHA='+target},
        {type:'runtime',value:'source Publisher 39609600546/1 and owner Issue comment 6308823032 independently read from GitHub'},
        {type:'runtime',value:'agent-store immutable Publisher intent commit='+commitSha+' tip='+tip},
        {type:'runtime',value:'real GitHub App PR #2176 original SHA='+verified.original_pr_sha+
          ' current SHA='+verified.current_pr_sha},
        {type:'runtime',value:'unique bounded e2e/fixtures/agent-development/1997-canary.txt at initial publisher commit'},
        {type:'runtime',value:'30+ source/branch/PR/Store forgery and replay selftest negatives passed'},
        {type:'runtime',value:'remaining: real Reviewer and original Developer repair then SHA B policy-based Acceptance, not a simulated Pass'},
      ],
    };
    console.log(JSON.stringify(result));
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
main().catch(error=>{
  const summary=error instanceof Error?error.message:String(error);
  console.error(summary);
  console.log(JSON.stringify({status:'fail',summary,
    evidence:[{type:'runtime',value:'SC-03 real Publisher source/Store/PR readback rejected'}]}));
  process.exitCode=1;
});
