'use strict';
// #1664 SC-15: no claim of an Agent outcome without persisted exact source
// run/attempt provenance and the production writer's replay/forgery negatives.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const repo = path.resolve(__dirname, '../../../../..');
const REPOSITORY = 'BestNathan/nession';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^sha256:[0-9a-f]{64}$/;
const developer = [
  {run:39396836009, path:'raw/workflows/agent-develop/2026-10-20/39396836009-1-issue-1997-development.json',
   sha:'2f75869833fb43ec54e88b560226f8913a6beac3'},
  {run:39448549052, path:'raw/workflows/agent-develop/2026-10-20/39448549052-1-issue-1997-development.json',
   sha:'271b48e494b6bd54843403b831709d6365f30530'},
];
function git(directory, ...args) {
  return execFileSync('git',['-C',directory,...args],{
    encoding:'utf8',timeout:45000,maxBuffer:2*1024*1024,
    stdio:['ignore','pipe','pipe'],
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
function json(file) {
  const stat=fs.lstatSync(file);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<1024*1024);
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function record(store,relative) {
  const root=path.resolve(store);
  const full=path.resolve(root,relative);
  assert.ok(full.startsWith(root+path.sep));
  const obj=json(full);
  assert.equal(obj.schema_version,1);
  assert.equal(obj.kind,'agent_workflow_run');
  assert.equal(obj.identity.repository,REPOSITORY);
  assert.equal(git(store,'log','-1','--format=%H','HEAD','--',relative).length,40,
    'metrics object must be committed to orphan history');
  return obj;
}
async function githubRun(id) {
  const url='https://api.github.com/repos/'+REPOSITORY+'/actions/runs/'+id;
  const response=await fetch(url,{
    headers:{Accept:'application/vnd.github+json', 'User-Agent':'nession-source-aligned-sc15-case',
      'X-GitHub-Api-Version':'2022-11-28'},
    signal:AbortSignal.timeout(15000),
  });
  assert.equal(response.status,200,'source GitHub Run unavailable or public API limited');
  const run=await response.json();
  assert.equal(run.id,id);
  assert.equal(run.repository?.full_name,REPOSITORY);
  assert.equal(run.head_repository?.full_name,REPOSITORY);
  assert.equal(run.run_attempt,1);
  assert.equal(run.status,'completed');
  assert.ok(['success','failure'].includes(run.conclusion));
  assert.match(run.head_sha,HEX40);
  return run;
}
async function telemetryArtifact(id,sha) {
  const response=await fetch('https://api.github.com/repos/'+REPOSITORY+
    '/actions/runs/'+id+'/artifacts?per_page=100',{
      headers:{Accept:'application/vnd.github+json','User-Agent':'nession-source-aligned-sc15-case',
        'X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000),
    });
  assert.equal(response.status,200,'immutable producer Artifact registry unavailable');
  const doc=await response.json();
  assert.ok(doc.total_count>=1&&doc.total_count<=100&&doc.artifacts.length===doc.total_count);
  const artifacts=doc.artifacts.filter(a=>a.name==='agent-telemetry-developer-'+id+'-1');
  assert.equal(artifacts.length,1,'one exact attempt-scoped real Developer telemetry Artifact required');
  const artifact=artifacts[0];
  assert.equal(artifact.expired,false);
  assert.match(artifact.digest,HEX64);
  assert.equal(artifact.workflow_run?.id,id);
  assert.equal(artifact.workflow_run?.head_sha,sha);
  return {id:artifact.id,digest:artifact.digest};
}
function localFixture(relative,...args) {
  execFileSync(process.execPath,[relative,...args],{
    cwd:repo,timeout:150000,maxBuffer:1024*1024,
    stdio:['ignore','pipe','pipe'],
  });
}
function findError(store) {
  // Bound this search to durable summaries only; the Git Store is an
  // independent historical observation, not a model-supplied receipt.
  const root=path.join(store,'raw','workflows');
  let inspected=0;
  for(const source of fs.readdirSync(root).sort()){
    const sourceDir=path.join(root,source);
    if(!fs.lstatSync(sourceDir).isDirectory())throw Error('unsafe metrics source directory');
    for(const day of fs.readdirSync(sourceDir).sort().reverse()){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('unsafe metrics date');
      const dayDir=path.join(sourceDir,day);
      if(!fs.lstatSync(dayDir).isDirectory())throw Error('unsafe metrics date directory');
      for(const filename of fs.readdirSync(dayDir).sort().reverse()){
        if(++inspected>50000)throw Error('unbounded metrics history');
        if(!/^[a-z0-9][a-z0-9._-]*\.json$/.test(filename))throw Error('unsafe metrics summary name');
        const relative='raw/workflows/'+source+'/'+day+'/'+filename;
        const summary=record(store,relative);
        if(summary.result?.status==='agent-error' &&
           summary.identity.github_run_attempt===1)
          return {summary,relative};
      }
    }
  }
  throw Error('missing authentic durable error Agent telemetry');
}
async function main(){
  const target=process.env.NESSION_ACCEPTANCE_TARGET_SHA;
  assert.match(target,HEX40,'Case requires an exact main SHA');
  assert.equal(git(repo,'rev-parse','HEAD'),target,'executed Case source SHA drift');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nession-sc15-'));
  try {
    const store=path.join(temp,'metrics');
    execFileSync('git',['clone','--quiet','--no-tags','--single-branch',
      '--branch','metrics','--','https://github.com/'+REPOSITORY+'.git',store],{
      timeout:90000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],
      env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
    });
    assert.equal(git(store,'symbolic-ref','--short','HEAD'),'metrics');
    const tip=git(store,'rev-parse','HEAD');
    assert.match(tip,HEX40);
    const proof=[];
    for(const input of developer){
      const summary=record(store,input.path);
      assert.equal(summary.identity.workflow_id,'agent-develop');
      assert.equal(summary.identity.github_workflow,'Agent / Development');
      assert.equal(summary.identity.github_run_id,input.run);
      assert.equal(summary.identity.github_run_attempt,1);
      assert.equal(summary.task.issue,1997);
      assert.equal(summary.agent.id,'dev-cursor-01');
      assert.equal(summary.agent.role,'developer');
      assert.equal(summary.agent.provider,'cursor');
      assert.match(summary.agent.harness_sha256,/^[a-f0-9]{64}$/);
      assert.equal(summary.agent.status,'finished');
      const source=await githubRun(input.run);
      assert.equal(source.path,'.github/workflows/agent-develop.yml');
      assert.equal(source.event,'workflow_dispatch');
      assert.equal(source.conclusion,'success');
      assert.equal(source.head_sha,input.sha);
      const artifact=await telemetryArtifact(input.run,input.sha);
      proof.push({run_id:input.run,attempt:1,artifact_id:artifact.id,
        stored_path:input.path,artifact_digest:artifact.digest});
    }
    // A failed Agent execution is represented as an error, not silently
    // coerced into successful zero-cost metrics.
    const error=findError(store);
    const bad=error.summary;
    assert.ok(Number.isSafeInteger(bad.identity.github_run_id));
    assert.equal(bad.identity.github_run_attempt,1);
    assert.ok(['agent-error'].includes(bad.result.status));
    const errorRun=await githubRun(bad.identity.github_run_id);
    assert.equal(errorRun.name,bad.identity.github_workflow);
    assert.ok(new Set([
      '.github/workflows/agent-provider-smoke.yml',
      '.github/workflows/agent-develop.yml',
      '.github/workflows/agent-issue-audit.yml',
      '.github/workflows/agent-sc-acceptance.yml',
      '.github/workflows/acceptance-orchestrator.yml',
      '.github/workflows/acceptance-verified-stage.yml',
    ]).has(errorRun.path),'error telemetry must come from a trusted Agent source');
    assert.equal(bad.identity.repository,REPOSITORY);
    // These execute the actual trusted ingestion parser: wrong Run/attempt,
    // unexpected unsafe fields, trace mutation, and conflicting immutable
    // replay fail closed; none writes to the public Store.
    localFixture('scripts/agent-telemetry-ingest.mjs','self-test');
    localFixture('scripts/agent-telemetry-reconcile.mjs','self-test');
    localFixture('scripts/agent-workflow-telemetry-contract.mjs','self-test');
    console.log(JSON.stringify({status:'pass',
      summary:'Exact main SHA executed canonical telemetry ingestion negatives; independently verified real completed Developer artifacts, durable metrics, and an error-class record.',
      evidence:[
        {type:'runtime',value:'exact main Case SHA='+target+' metrics orphan tip='+tip},
        ...proof.map(p=>({type:'runtime',value:JSON.stringify(p)})),
        {type:'runtime',value:'error Agent record='+error.relative+
          ' source run='+bad.identity.github_run_id+' outcome='+bad.result.status},
        {type:'runtime',value:'trusted replay/forgery/unsafe-field negative fixtures passed'},
      ],
    }));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{
  const message=error instanceof Error?error.message:String(error);
  console.error(message);
  console.log(JSON.stringify({status:'fail',summary:message,
    evidence:[{type:'runtime',value:'SC-15 real-run Metrics source/persistence or negative contract missing'}]}));
  process.exitCode=1;
});
