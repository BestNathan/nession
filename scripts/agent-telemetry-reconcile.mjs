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
  {file:'agent-develop.yml',name:'Agent / Development',id:'agent-develop',
    events:['workflow_dispatch'],branches:['main']},
  {file:'agent-cursor-resume-seed.yml',name:'Agent / Cursor Resume Seed',id:'agent-cursor-resume-seed',
    events:['push','workflow_dispatch'],branches:['main']},
  {file:'agent-cursor-resume-verify.yml',name:'Agent / Cursor Resume Verify',id:'agent-cursor-resume-verify',
    events:['workflow_run'],branches:['main']},
  {file:'agent-claude-resume-seed.yml',name:'Agent / Claude Resume Seed',id:'agent-claude-resume-seed',
    events:['push','workflow_dispatch'],branches:['main']},
  {file:'agent-claude-resume-verify.yml',name:'Agent / Claude Resume Verify',id:'agent-claude-resume-verify',
    events:['workflow_run'],branches:['main']},
  {file:'agent-sc-acceptance.yml',name:'Agent / SC Acceptance',id:'requirement-acceptance',
    events:['workflow_dispatch'],branches:['main']},
  {file:'agent-issue-audit.yml',name:'Agent / Issue Audit',id:'issue-audit',
    events:['issues','workflow_dispatch'],branches:['main']},
  {file:'acceptance-orchestrator.yml',name:'Acceptance / Orchestrator',id:'requirement-acceptance',
    events:['pull_request_target','push','issues'],branches:['main','staging']},
  {file:'acceptance-verified-stage.yml',name:'Acceptance / Verified Issue Stage',id:'requirement-acceptance',
    events:['issue_comment'],branches:['main']},
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
export function countArtifactSummaries(value,run=null){
  if(run && (!positive(Number(run.id)) || !positive(Number(run.run_attempt))))
    fail('invalid source run identity for attempt-scoped artifact count');
  const suffix=run ? '-'+String(run.id)+'-'+String(run.run_attempt) : null;
  if(!value||!Array.isArray(value.artifacts)||!Number.isSafeInteger(value.total_count)||
     value.total_count<0||value.total_count>MAX_ARTIFACTS||
     value.artifacts.length!==value.total_count)fail('incomplete/oversized artifact listing');
  let count=0;
  const names=new Set();
  for(const artifact of value.artifacts){
    if(typeof artifact.name!=='string'||
       !Number.isSafeInteger(artifact.size_in_bytes)||artifact.size_in_bytes<0)
      fail('invalid source artifact');
    // GH allows different workflow attempts to publish the same unrelated
    // artifact name (e.g. acceptance-result-<run_id>). Only matching telemetry
    // names need to be unique within one authenticated attempt.
    if(artifact.name.startsWith('agent-telemetry-') &&
       artifact.expired===false &&
       (suffix===null || artifact.name.endsWith(suffix))){
      if(names.has(artifact.name))fail('duplicate source artifact');
      names.add(artifact.name);
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
export function validateReconciliationContext(env){
  if(env.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_REF!=='refs/heads/main')
    fail('reconciler must execute only on trusted main');
  if(env.GITHUB_EVENT_NAME==='schedule')return 'schedule';
  fail('reconciliation denied: only main schedule may scan history');
}
async function select(store){
  validateReconciliationContext(process.env);
  if(!path.isAbsolute(store))fail('absolute trusted Metrics Store path required');
  const summaryCounts=indexedSourceSummaries(store),runsBySource=new Map();
  for(const source of SOURCES){
    const response=ghJson('actions/workflows/'+source.file+
      '/runs?status=completed&per_page='+MAX_RUNS);
    if(!Array.isArray(response.workflow_runs))fail('malformed GitHub workflow run listing');
    runsBySource.set(source.file,response.workflow_runs);
  }
  const result=await chooseMissing(runsBySource,summaryCounts,async run=>{
    const artifacts=ghJson('actions/runs/'+run.id+'/artifacts?per_page='+MAX_ARTIFACTS);
    return countArtifactSummaries(artifacts,run);
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
  if(!job.includes("- name: Select missed trusted Agent telemetry source\n        if: github.event_name == 'schedule'")||
     !job.includes("- name: Checkout metrics history\n        if: github.event_name == 'schedule' || steps.event_artifacts.outputs.count != '0'")||
     !job.includes("if: (github.event_name == 'workflow_run' && steps.event_artifacts.outputs.count != '0') || steps.reconcile.outputs.run_id != ''")||
     job.includes("steps.event_artifacts.outputs.count == '0'")||
     !job.includes('run_id="${RECOVERY_RUN_ID:-${EVENT_RUN_ID:-}}"'))
    fail('empty telemetry events must skip history and scheduled recovery; retain source precedence');
  if(!job.includes('"${RUN_ID}" == "${EVENT_RUN_ID}"')||
     !job.includes('"${RUN_ATTEMPT}" == "${EVENT_RUN_ATTEMPT}"')||
     !job.includes('cp "${RUNNER_TEMP}/event-source-artifacts.json" "${RUNNER_TEMP}/source-artifacts.json"'))
    fail('attempt-pinned event artifact listing reuse missing');
  // A schedule scan can legitimately discover no missing run. Skipped
  // source/artifact steps produce empty strings, not the literal '0'.
  // Every consumer must guard both cases; otherwise an empty scan tries to
  // download an undefined run ID and becomes a false workflow failure.
  const artifactConsumers=job.match(/steps\.artifacts\.outputs\.count != '' && steps\.artifacts\.outputs\.count != '0'/g)??[];
  if(artifactConsumers.length!==5)
    fail('missing empty-artifact no-op guard in a privileged ingest consumer');
  const scopedCounts=job.match(/agent-telemetry-reconcile\.mjs artifact-count/g)??[];
  if(scopedCounts.length!==2 ||
     !job.includes('EVENT_RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}') ||
     !job.includes('RUN_ATTEMPT: ${{ steps.source.outputs.run_attempt }}') ||
     !job.includes('--pattern "agent-telemetry-*-${RUN_ID}-${RUN_ATTEMPT}"'))
    fail('source attempt-scoped telemetry discovery/download is required');
  if(!workflow.includes("github.event.workflow_run.event == 'push'") ||
     !workflow.includes("github.event.workflow_run.event == 'pull_request_target'"))
    fail('source event routing omitted');
  // Never report successful metrics ingestion as failed merely because the
  // *authentic source Provider job* failed. Only a successful source may wake
  // Acceptance; all source identity checks still apply to success cases.
  if(!workflow.includes("jq -r '.conclusion // \"\"'")||
     !workflow.includes("Verified failed Provider telemetry archived; no success-only Acceptance wake")||
     !workflow.includes('.status == "completed" and .conclusion == "success"'))
    fail('failed Provider evidence must not trigger success-only Acceptance wake');
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
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("Verified failed Provider telemetry archived; no success-only Acceptance wake",
      "Always wake Acceptance irrespective of Provider conclusion")
  ),/failed Provider evidence/);
    const mainEnv={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main'};
  assert.equal(validateReconciliationContext({...mainEnv,GITHUB_EVENT_NAME:'schedule'}),'schedule');
  for(const invalid of [
    {...mainEnv,GITHUB_EVENT_NAME:'workflow_dispatch'},
    {...mainEnv,GITHUB_EVENT_NAME:'workflow_run',RECOVERY_EVENT_RUN_ID:'321',RECOVERY_EMPTY_SOURCE_COUNT:'1'},
    {...mainEnv,GITHUB_EVENT_NAME:'workflow_run',RECOVERY_EVENT_RUN_ID:'0',RECOVERY_EMPTY_SOURCE_COUNT:'0'},
    {...mainEnv,GITHUB_EVENT_NAME:'workflow_run',RECOVERY_EVENT_RUN_ID:'feature',RECOVERY_EMPTY_SOURCE_COUNT:'0'},
    {...mainEnv,GITHUB_EVENT_NAME:'workflow_run',RECOVERY_EVENT_RUN_ID:'321'},
    {...mainEnv,GITHUB_EVENT_NAME:'schedule',GITHUB_REF:'refs/heads/feature'},
    {...mainEnv,GITHUB_EVENT_NAME:'schedule',GITHUB_REPOSITORY:'attacker/fork'},
  ])assert.throws(()=>validateReconciliationContext(invalid),/reconciliation denied|trusted main/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "- name: Select missed trusted Agent telemetry source\n        if: github.event_name == 'schedule'",
    "- name: Select missed trusted Agent telemetry source\n        if: github.event_name == 'workflow_run'"
  )),/empty telemetry events/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "github.event_name == 'schedule' || steps.event_artifacts.outputs.count != '0'",
    "github.event_name == 'schedule' || steps.event_artifacts.outputs.count == '0'"
  )),/empty telemetry events/);
  // Empty telemetry must not proceed through source resolution after preflight.
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "if: (github.event_name == 'workflow_run' && steps.event_artifacts.outputs.count != '0') || steps.reconcile.outputs.run_id != ''",
    "if: github.event_name == 'workflow_run' || steps.reconcile.outputs.run_id != ''"
  )),/empty telemetry events/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    '"${RUN_ATTEMPT}" == "${EVENT_RUN_ATTEMPT}"',
    '"${RUN_ATTEMPT}" != "${EVENT_RUN_ATTEMPT}"'
  )),/attempt-pinned/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "steps.artifacts.outputs.count != '' && steps.artifacts.outputs.count != '0'",
    "steps.artifacts.outputs.count != '0'"
  )),/empty-artifact no-op guard/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    '--pattern "agent-telemetry-*-${RUN_ID}-${RUN_ATTEMPT}"',
    "--pattern 'agent-telemetry-*'"
  )),/attempt-scoped/);


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
  // A real rerun may publish both attempts under the same run id. Do not
  // misinterpret earlier attempt artifacts as current-attempt receipts.
  const attempt1={...artifact,name:'agent-telemetry-source-321-1'};
  const attempt2={...artifact,name:'agent-telemetry-source-321-2'};
  const both={total_count:2,artifacts:[attempt1,attempt2]};
  assert.equal(countArtifactSummaries(both,{id:321,run_attempt:1}),1);
  assert.equal(countArtifactSummaries(both,{id:321,run_attempt:2}),1);
  assert.equal(countArtifactSummaries(both,{id:321,run_attempt:3}),0);
  assert.equal(countArtifactSummaries(both,{id:322,run_attempt:1}),0);
  const resultArtifact={name:'acceptance-result-321',size_in_bytes:200,expired:false};
  const withCrossAttemptResultNames={total_count:4,artifacts:[
    attempt1,attempt2,resultArtifact,{...resultArtifact,size_in_bytes:240},
  ]};
  assert.equal(countArtifactSummaries(withCrossAttemptResultNames,
    {id:321,run_attempt:2}),1);
  assert.throws(()=>countArtifactSummaries({total_count:3,artifacts:[
    attempt2,attempt2,resultArtifact,
  ]},{id:321,run_attempt:2}),/duplicate source artifact/);
  assert.throws(()=>countArtifactSummaries(both,{id:321,run_attempt:0}),/invalid source/);
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
  const operation=cmd==='self-test'?selfTest():
    cmd==='select'?select(process.argv[3]):
    cmd==='artifact-count'?Promise.resolve().then(()=>{
      const [file,id,attempt]=process.argv.slice(3);
      if(!file || !/^[1-9][0-9]*$/.test(id??'') || !/^[1-9][0-9]*$/.test(attempt??''))
        fail('usage: artifact-count GITHUB_ARTIFACTS_JSON SOURCE_RUN_ID RUN_ATTEMPT');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      console.log(countArtifactSummaries(data,{id:Number(id),run_attempt:Number(attempt)}));
    }):Promise.reject(Error('usage: self-test | select ABS_METRICS_DIR | artifact-count GITHUB_ARTIFACTS_JSON RUN_ID ATTEMPT'));
  operation.catch(e=>{console.error(e.message);process.exitCode=1;});
}
