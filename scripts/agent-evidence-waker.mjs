#!/usr/bin/env node
// Read-only post-merge evidence waker. A repository_dispatch payload is only a
// locator: actual GitHub Run identity and persisted Metrics records are checked
// independently. Only the existing Agent SC Acceptance workflow projects SCs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO='BestNathan/nession', WORKFLOW='.github/workflows/agent-provider-smoke.yml';
const HEX40=/^[a-f0-9]{40}$/;
function fail(why){throw new Error('post-merge evidence waker: '+why);}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
function readRecord(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)fail('unsafe Metrics record file');
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{fail('invalid Metrics record JSON');}
}
export function validateWakeSource(payload,run){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
     Object.keys(payload).sort().join(',')!=='source_run_attempt,source_run_id,target_sha' ||
     !positive(payload.source_run_id)||!positive(payload.source_run_attempt)||
     !HEX40.test(payload.target_sha??'')) fail('invalid wake-up locator');
  if(run?.id!==payload.source_run_id ||run.run_attempt!==payload.source_run_attempt||
     run.path!==WORKFLOW||run.name!=='Agent / Provider Smoke'||
     run.event!=='push'||run.head_branch!=='main'||run.head_sha!==payload.target_sha||
     run.status!=='completed'||run.conclusion!=='success'||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO) {
    fail('source is not completed trusted main Provider Smoke');
  }
  return {run_id:run.id,attempt:run.run_attempt,target_sha:run.head_sha};
}
export function verifyDurableTelemetry(root,verified){
  const parent=path.join(root,'raw','workflows','agent-provider-smoke');
  if(!fs.existsSync(parent)||!fs.lstatSync(parent).isDirectory()||
     fs.lstatSync(parent).isSymbolicLink())fail('trusted Metrics store/source folder unavailable');
  let matches=0;
  // The run can span UTC midnight: one bounded scan across provider-smoke
  // date folders, never a checkout of untrusted PR source.
  const folders=fs.readdirSync(parent).sort();
  if(folders.length>1500)fail('unbounded Metrics history');
  for(const folder of folders){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(folder))fail('unexpected Metrics date partition');
    const dir=path.join(parent,folder),stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe Metrics partition');
    const candidates=fs.readdirSync(dir).filter(name=>name.startsWith(
      verified.run_id+'-'+verified.attempt+'-')&&name.endsWith('.json'));
    if(candidates.length>100)fail('unbounded source Metrics records');
    for(const name of candidates){
      const rec=readRecord(path.join(dir,name));
      if(rec.kind!=='agent_workflow_run'||rec.identity?.github_run_id!==verified.run_id||
         rec.identity?.github_run_attempt!==verified.attempt||
         rec.identity?.workflow_id!=='agent-provider-smoke'||
         rec.identity?.repository!==REPO||rec.identity?.event!=='push'||
         rec.task?.target_ref!==verified.target_sha) {
        fail('persisted Metrics identity does not match authenticated run');
      }
      matches++;
    }
  }
  if(matches===0)fail('no persisted source-aligned canonical Agent telemetry');
  return {matches};
}
export function verifyWake(payload,run,root){
  const verified=validateWakeSource(payload,run);
  return {...verified,...verifyDurableTelemetry(root,verified)};
}
const WAKE_OWNERS=[
  '.github/workflows/metrics-agent-telemetry.yml',
  '.github/workflows/acceptance-orchestrator.yml',
  'scripts/agent-evidence-waker.mjs',
  'scripts/agent-telemetry-ingest.mjs',
];
// These selectors are part of the end-to-end evidence dependency graph:
// a trusted wake owner change must generate a fresh main Provider Smoke before
// a subsequent authenticated Metrics ingest can wake merged Agent SC checks.
export function validateWakeProducerTrigger(workflow){
  const trigger=workflow.split(/^permissions:/m)[0];
  const mainPush=/^  push:\s*\n    branches: \[main\]\s*\n    paths:\s*\n((?:      (?:- [^\n]+|#[^\n]*)\n)+)/m.exec(trigger);
  if(!mainPush)fail('Provider Smoke must have a main-only push paths selector');
  const selected=new Set(mainPush[1].trim().split('\n').map(x=>x.trim()).filter(x=>x.startsWith('- ')).map(x=>x.slice(2)));
  for(const owner of WAKE_OWNERS){
    if(!selected.has(owner))fail('missing Provider Smoke wake source: '+owner);
  }
  return {sources:WAKE_OWNERS.length};
}
function selfTest(){
  const wf=fs.readFileSync('.github/workflows/agent-provider-smoke.yml','utf8');
  assert.deepEqual(validateWakeProducerTrigger(wf),{sources:4});
  for(const owner of WAKE_OWNERS){
    assert.throws(()=>validateWakeProducerTrigger(
      wf.replace('      - '+owner+'\n','')
    ),/missing Provider Smoke wake source/);
  }
  assert.throws(()=>validateWakeProducerTrigger(
    wf.replace('branches: [main]','branches: [feature]')
  ),/main-only/);
  const sha='a'.repeat(40),payload={source_run_id:789,source_run_attempt:1,target_sha:sha};
  const run={id:789,run_attempt:1,path:WORKFLOW,name:'Agent / Provider Smoke',
    event:'push',head_branch:'main',head_sha:sha,status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO}};
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-evidence-waker-'));
  try{
    const dir=path.join(root,'raw/workflows/agent-provider-smoke/2026-10-13');
    fs.mkdirSync(dir,{recursive:true});
    const f=path.join(dir,'789-1-issue-1664-dev-qwen-canary-claude-code.json');
    const record={kind:'agent_workflow_run',
      identity:{github_run_id:789,github_run_attempt:1,workflow_id:'agent-provider-smoke',
        repository:REPO,event:'push'},
      task:{target_ref:sha}};
    fs.writeFileSync(f,JSON.stringify(record)+'\n');
    assert.deepEqual(verifyWake(payload,run,root),{run_id:789,attempt:1,target_sha:sha,matches:1});
    assert.throws(()=>verifyWake({...payload,target_sha:'b'.repeat(40)},run,root),/source is not/);
    assert.throws(()=>verifyWake({...payload,source_run_attempt:2},run,root),/source is not/);
    assert.throws(()=>verifyWake({...payload,issue_number:1664},run,root),/locator/);
    assert.throws(()=>verifyWake(payload,{...run,path:'evil.yml'},root),/source is not/);
    assert.throws(()=>verifyWake(payload,{...run,event:'pull_request_target'},root),/source is not/);
    assert.throws(()=>verifyWake(payload,{...run,head_branch:'staging'},root),/source is not/);
    assert.throws(()=>verifyWake(payload,{...run,conclusion:'failure'},root),/source is not/);
    assert.throws(()=>verifyWake(payload,{...run,head_repository:{full_name:'attacker/fork'}},root),/source is not/);
    fs.writeFileSync(f,JSON.stringify({...record,task:{target_ref:'c'.repeat(40)}}));
    assert.throws(()=>verifyWake(payload,run,root),/identity does not match/);
    fs.unlinkSync(f);
    assert.throws(()=>verifyWake(payload,run,root),/no persisted/);
    fs.symlinkSync('/etc/passwd',f);
    assert.throws(()=>verifyWake(payload,run,root),/unsafe Metrics record file/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  console.log('post-merge evidence waker: source, digest lineage and negative fixtures passed');
}
if(process.argv[2]==='self-test')selfTest();
else if(process.argv[2]==='verify'){
  const [payloadFile,runFile,metricsRoot]=process.argv.slice(3);
  if(!payloadFile||!runFile||!metricsRoot)fail('usage: verify PAYLOAD_JSON GITHUB_RUN_JSON METRICS_ROOT');
  const result=verifyWake(readRecord(payloadFile),readRecord(runFile),metricsRoot);
  console.log(JSON.stringify(result));
}else fail('usage: self-test | verify ...');
