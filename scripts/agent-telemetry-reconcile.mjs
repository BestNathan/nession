#!/usr/bin/env node
// Main-only read-only discovery. This selects a GitHub-authenticated source run;
// the existing Metrics / Agent Telemetry Ingest workflow still exclusively
// validates, stages, publishes and dispatches its canonical artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateAgentWorkflowTelemetry} from './agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const MAX_RUNS=100, MAX_ARTIFACTS=100, MAX_BYTES=1024*1024;
const SOURCES=Object.freeze([
  {file:'agent-provider-smoke.yml',name:'Agent / Provider Smoke',id:'agent-provider-smoke',
    events:['push','workflow_dispatch'],branches:['main']},
  {file:'agent-sc-acceptance.yml',name:'Agent / SC Acceptance',id:'requirement-acceptance',
    events:['workflow_dispatch'],branches:['main']},
  {file:'agent-issue-audit.yml',name:'Agent / Issue Audit',id:'issue-audit',
    events:['issues','workflow_dispatch'],branches:['main']},
  {file:'acceptance-orchestrator.yml',name:'Acceptance / Orchestrator',id:'requirement-acceptance',
    events:['pull_request_target','push','issues'],branches:['main','staging']},
]);
function fail(message){throw Error('Agent telemetry reconciliation: '+message);}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
export function trustedSource(run,source){
  if(!run||typeof run!=='object'||Array.isArray(run))return false;
  if(!positive(run.id)||!positive(run.run_attempt)||!SHA.test(run.head_sha??'')||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     run.path!=='.github/workflows/'+source.file||run.name!==source.name||
     run.status!=='completed'||!['success','failure'].includes(run.conclusion)||
     !source.events.includes(run.event))return false;
  // Agent source workflows with credentials must be pinned to main. The
  // orchestrator may verify a PR head, but its source workflow is trusted main.
  if(source.file!=='acceptance-orchestrator.yml' && run.head_branch!=='main')return false;
  if(run.event==='push'&&!source.branches.includes(run.head_branch))return false;
  return true;
}
export function countArtifactSummaries(value){
  if(!value||!Array.isArray(value.artifacts)||!Number.isSafeInteger(value.total_count)||
     value.total_count<0||value.total_count>MAX_ARTIFACTS||
     value.artifacts.length!==value.total_count)fail('incomplete/oversized artifact listing');
  let count=0;
  const names=new Set();
  for(const artifact of value.artifacts){
    if(typeof artifact.name!=='string'||names.has(artifact.name)||
       !Number.isSafeInteger(artifact.size_in_bytes)||artifact.size_in_bytes<0)
      fail('invalid/duplicate source artifact');
    names.add(artifact.name);
    if(artifact.name.startsWith('agent-telemetry-') && artifact.expired===false){
      if(artifact.size_in_bytes===0||artifact.size_in_bytes>8*1024*1024)
        fail('invalid telemetry artifact size');
      count++;
    }
  }
  return count;
}
// Count only validated immutable summaries, not traces or filenames (which are
// not a trustworthy source of run IDs). The downstream ingest checks every
// downloaded artifact again, including missing/divergent traces and digests.
export function indexedSourceSummaries(root){
  const summaryCounts=new Map();
  let inspected=0;
  for(const source of SOURCES){
    const dir=path.join(root,'raw','workflows',source.id);
    if(!fs.existsSync(dir))continue;
    if(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink())
      fail('unsafe Metrics directory');
    for(const date of fs.readdirSync(dir)){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))fail('unsafe Metrics partition');
      const dateDir=path.join(dir,date),st=fs.lstatSync(dateDir);
      if(!st.isDirectory()||st.isSymbolicLink())fail('unsafe Metrics partition type');
      for(const file of fs.readdirSync(dateDir)){
        if(++inspected>50000)fail('Metrics index exceeds bounded scan');
        if(!/^[a-z0-9][a-z0-9._-]*\.json$/.test(file))fail('unsafe Metrics record name');
        const full=path.join(dateDir,file),meta=fs.lstatSync(full);
        if(!meta.isFile()||meta.isSymbolicLink()||meta.size>MAX_BYTES)
          fail('unsafe Metrics record');
        const record=JSON.parse(fs.readFileSync(full,'utf8'));
        validateAgentWorkflowTelemetry(record);
        if(record.identity.workflow_id!==source.id||
           record.identity.repository!==REPO)fail('untrusted stored summary identity');
        const key=source.id+'/'+record.identity.github_run_id+'/'+record.identity.github_run_attempt;
        const unique=record.identity.unique_run_name;
        const set=summaryCounts.get(key)??new Set();
        set.add(unique);summaryCounts.set(key,set);
      }
    }
  }
  return new Map([...summaryCounts].map(([key,value])=>[key,value.size]));
}
export async function chooseMissing(runsBySource,summaryCounts,artifactCount){
  // Provider is first so a cancelled ingest cannot strand merged-SHA SC wake.
  // Oldest eligible first within each bounded source listing avoids starvation.
  for(const source of SOURCES){
    const runs=runsBySource.get(source.file)??[];
    if(!Array.isArray(runs)||runs.length>MAX_RUNS)fail('unbounded source listing');
    const ordered=runs.filter(run=>trustedSource(run,source))
      .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
    for(const run of ordered){
      const key=source.id+'/'+run.id+'/'+run.run_attempt;
      const recorded=summaryCounts.get(key)??0;
      const published=await artifactCount(run);
      if(published>recorded)return {run_id:run.id,run_attempt:run.run_attempt,
        source_path:run.path,target_sha:run.head_sha,recorded,published};
    }
  }
  return null;
}
function ghJson(endpoint){
  const output=execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
    encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,
    stdio:['ignore','pipe','pipe'],
  });
  return JSON.parse(output);
}
async function select(store){
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.GITHUB_EVENT_NAME!=='schedule'||
     process.env.GITHUB_REF!=='refs/heads/main'||
     !path.isAbsolute(store))fail('reconciler must be trusted scheduled main checkout');
  const summaryCounts=indexedSourceSummaries(store),runsBySource=new Map();
  for(const source of SOURCES){
    const response=ghJson('actions/workflows/'+source.file+
      '/runs?status=completed&per_page='+MAX_RUNS);
    if(!Array.isArray(response.workflow_runs))fail('malformed GitHub workflow run listing');
    runsBySource.set(source.file,response.workflow_runs);
  }
  const result=await chooseMissing(runsBySource,summaryCounts,async run=>{
    const artifacts=ghJson('actions/runs/'+run.id+'/artifacts?per_page='+MAX_ARTIFACTS);
    return countArtifactSummaries(artifacts);
  });
  console.log(JSON.stringify(result??{run_id:null}));
}
// The scheduled replay is allowed only through trusted main-selected workflow
// code; an arbitrary-ref workflow_dispatch cannot obtain the metrics writer.
export function validateRecoveryRouting(workflow){
  const trigger=workflow.split(/^permissions:/m)[0];
  const job=workflow.split(/^jobs:/m)[1]??'';
  if(!/^  schedule:\s*\n    - cron: '[^'\n]+'\s*$/m.test(trigger) ||
     /^  workflow_dispatch:/m.test(trigger))
    fail('Metrics replay must be scheduled-only, never arbitrary-ref dispatch');
  if(!job.includes("github.event_name == 'schedule' && github.ref == 'refs/heads/main'")||
     !job.includes("github.repository == 'BestNathan/nession'"))
    fail('missing trusted main schedule guard');
  for(const source of SOURCES){
    if(!trigger.includes('      - '+source.name)||
       !job.includes("github.event.workflow_run.name == '"+source.name+"'"))
      fail('unclassified or unregistered Agent source: '+source.name);
  }
  if(!workflow.includes('node scripts/agent-telemetry-reconcile.mjs select')||
     !workflow.includes('run-store-integrity.mjs"'))
    fail('trusted reconciliation or immutable Store Gate omitted');
  if(!workflow.includes("github.event.workflow_run.event == 'push'") ||
     !workflow.includes("github.event.workflow_run.event == 'pull_request_target'"))
    fail('source event routing omitted');
  return true;
}
function selfTest(){
  const workflow=fs.readFileSync('.github/workflows/metrics-agent-telemetry.yml','utf8');
  assert.equal(validateRecoveryRouting(workflow),true);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("  schedule:\n", "  workflow_dispatch:\n  schedule:\n")
  ),/scheduled-only/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("github.event_name == 'schedule' && github.ref == 'refs/heads/main'",
      "github.event_name == 'schedule'")
  ),/trusted main/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("node scripts/agent-telemetry-reconcile.mjs select", "echo skip")
  ),/Gate omitted/);
  const source=SOURCES[0],sha='a'.repeat(40);
  const run={id:321,run_attempt:1,head_sha:sha,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    path:'.github/workflows/'+source.file,name:source.name,
    status:'completed',conclusion:'success',event:'push',head_branch:'main',
    created_at:'2026-10-14T00:00:00Z'};
  assert.equal(trustedSource(run,source),true);
  for(const malicious of [
    {...run,repository:{full_name:'attacker/fork'}},
    {...run,head_repository:{full_name:'attacker/fork'}},
    {...run,path:'.github/workflows/evil.yml'},
    {...run,event:'pull_request'},
    {...run,head_branch:'feature'},
    {...run,status:'in_progress'},
    {...run,conclusion:'cancelled'},
    {...run,head_sha:'main'},
    {...run,run_attempt:0},
  ])assert.equal(trustedSource(malicious,source),false);
  const artifact={name:'agent-telemetry-provider-321',size_in_bytes:123,
    expired:false};
  assert.equal(countArtifactSummaries({total_count:1,artifacts:[artifact]}),1);
  assert.equal(countArtifactSummaries({total_count:1,artifacts:[{...artifact,expired:true}]}),0);
  assert.throws(()=>countArtifactSummaries({total_count:2,artifacts:[artifact]}),/incomplete/);
  assert.throws(()=>countArtifactSummaries({total_count:2,artifacts:[artifact,artifact]}),/duplicate/);
  const runs=new Map([[source.file,[{...run,id:322,created_at:'2026-10-14T01:00:00Z'},run]]]);
  return (async()=>{
    const selected=await chooseMissing(runs,new Map(),async()=>1);
    assert.equal(selected.run_id,321);
    const replay=await chooseMissing(runs,new Map([
      ['agent-provider-smoke/321/1',1]]),async()=>1);
    assert.equal(replay.run_id,322);
    const complete=await chooseMissing(runs,new Map([
      ['agent-provider-smoke/321/1',1],['agent-provider-smoke/322/1',1]]),async()=>1);
    assert.equal(complete,null);
    const absent=await chooseMissing(runs,new Map(),async()=>0);
    assert.equal(absent,null);
    assert.equal(await chooseMissing(new Map([[source.file,[{
      ...run,head_repository:{full_name:'attacker/fork'}}]]]),
    new Map(),async()=>1),null);
    console.log('Agent Metrics reconciliation: cancelled pending replay, SHA/source/artifact negatives, idempotent selection passed');
  })();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const cmd=process.argv[2];
  (cmd==='self-test'?selfTest():
    cmd==='select'?select(process.argv[3]):Promise.reject(Error('usage: self-test | select ABS_METRICS_DIR')))
  .catch(e=>{console.error(e.message);process.exitCode=1;});
}
