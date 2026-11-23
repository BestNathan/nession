#!/usr/bin/env node
// #4342 SC-05/P3: bounded READ-ONLY historical Agent telemetry inventory.
// This script never writes metrics, dispatches workflows or manufactures usage.
// A completed workflow without an observed Agent artifact is UNKNOWN/no-model,
// never proof of zero model calls. Expired objects cannot be recovered by guess.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {telemetryWorkflowSources} from './workflow-conventions.mjs';
import {validateTelemetrySourceRun} from './agent-workflow-telemetry-contract.mjs';
import {indexedSourceSummaries} from './agent-telemetry-reconcile.mjs';

const REPO='BestNathan/nession';
const SHA=/^[0-9a-f]{40}$/;
const START='2026-11-09T00:00:00Z';
const MAX_PAGES_PER_SOURCE=12;
const PAGE_SIZE=100;
const MAX_SOURCE_RUNS=3000;
const MAX_ARTIFACT_CALLS=2500;
const ARTIFACT_PAGE_SIZE=100;
const MAX_OUTPUT_BYTES=6*1024*1024;
const statuses=new Set(['ingested','missing','expired','partial',
  'no_artifact_observed','unobserved_or_expired','invalid','unscanned']);
const fail=x=>{throw Error('Agent telemetry historical inventory: '+x);};
const positive=x=>Number.isSafeInteger(x)&&x>0;

export function classifyHistoryRun(run,source,artifacts,recorded,now) {
  const origin=run?.repository?.full_name===REPO&&
    run?.head_repository?.full_name===REPO&&SHA.test(run.head_sha??'')&&
    run?.path===source.path&&Number.isSafeInteger(run?.id)&&run.id>0&&
    Number.isSafeInteger(run?.run_attempt)&&run.run_attempt>0&&
    run?.status==='completed'&&['success','failure'].includes(run.conclusion);
  if(!origin)return {status:'invalid',reason:'source REST identity, completion or SHA rejected'};
  try{
    const verified=validateTelemetrySourceRun(run,REPO);
    if(verified.source_workflow_key!==source.key||
       verified.workflow_id!==source.group_id)throw Error('Catalog source/group mismatch');
  }catch{return {status:'invalid',reason:'Catalog source policy rejected'};}
  if(!Number.isSafeInteger(recorded)||recorded<0)fail('untrusted stored summary count');
  if(!artifacts||!Array.isArray(artifacts.artifacts)||
     !Number.isSafeInteger(artifacts.total_count)||
     artifacts.total_count!==artifacts.artifacts.length||
     artifacts.artifacts.length>ARTIFACT_PAGE_SIZE)
    return {status:'invalid',reason:'incomplete/unbounded artifact listing'};
  const expectedSuffix='-'+String(run.id)+'-'+String(run.run_attempt);
  const observed=artifacts.artifacts.filter(a=>
    typeof a.name==='string'&&a.name.startsWith('agent-telemetry-')&&
    a.name.endsWith(expectedSuffix));
  if(observed.some(a=>!positive(a.id)||!Number.isSafeInteger(a.size_in_bytes)||
      a.size_in_bytes<0||typeof a.expired!=='boolean')||
      new Set(observed.map(a=>a.name)).size!==observed.length)
    return {status:'invalid',reason:'malformed/duplicate attempt-scoped Artifact'};
  const available=observed.filter(a=>a.expired===false);
  const expired=observed.filter(a=>a.expired===true);
  const details={
    stored_summaries:recorded,available_artifacts:available.length,
    expired_artifacts:expired.length,
    artifacts:observed.slice(0,25).map(a=>({
      artifact_id:a.id,name:a.name,expired:a.expired,
      url:'https://github.com/'+REPO+'/actions/runs/'+run.id+'/artifacts/'+a.id,
    })),
  };
  if(recorded>=observed.length&&recorded>0)
    return {...details,status:'ingested',reason:'immutable summaries exist for source/attempt'};
  if(available.length>recorded)
    return {...details,status:recorded>0?'partial':'missing',
      reason:'authentic nonexpired Agent Artifact lacks corresponding immutable summary'};
  if(expired.length>0&&recorded<observed.length)
    return {...details,status:'expired',
      reason:'GitHub reports expired Agent Artifact; do not fabricate it'};
  if(recorded>0)
    return {...details,status:'ingested',
      reason:'immutable summaries retained although source Artifacts are absent'};
  const created=Date.parse(run.created_at??'');
  const old=Number.isFinite(created)&&now-created>14*24*60*60*1000;
  return {...details,status:old?'unobserved_or_expired':'no_artifact_observed',
    reason:old?'expired retention window: absence cannot prove no model invocation':
      'no attempt-scoped Agent artifact observed: may be intentional no-model run'};
}
function ghJson(endpoint){
  const data=execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],{
    encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000,
    stdio:['ignore','pipe','pipe'],
  });
  return JSON.parse(data);
}
export function validateHistoryContext(env){
  if(env.GITHUB_REPOSITORY!==REPO||env.GITHUB_REF!=='refs/heads/main'||
     env.GITHUB_EVENT_NAME!=='schedule')
    fail('only protected main-owned schedule may inventory historical Metrics');
  return true;
}
function sourceCatalog(){
  const sources=telemetryWorkflowSources();
  if(sources.length<14||new Set(sources.map(s=>s.key)).size!==sources.length||
     new Set(sources.map(s=>s.path)).size!==sources.length)
    fail('source Catalog key/path parity failed');
  return sources;
}
function scan(store,output){
  validateHistoryContext(process.env);
  if(!path.isAbsolute(store)||!path.isAbsolute(output))fail('absolute paths required');
  const dateEnd=new Date();
  if(Number.isNaN(dateEnd.getTime())||dateEnd.getTime()<Date.parse(START))
    fail('invalid UTC observation window');
  const end=dateEnd.toISOString(),created=START+'..'+end;
  const stored=indexedSourceSummaries(store),sources=sourceCatalog();
  const records=[],truncation=[],totals=Object.fromEntries([...statuses].map(x=>[x,0]));
  let listed=0,artifactCalls=0;
  for(const source of sources){
    let done=false;
    for(let page=1;page<=MAX_PAGES_PER_SOURCE;page++){
      const query='actions/workflows/'+source.file+'/runs?status=completed'+
        '&created='+encodeURIComponent(created)+'&per_page='+PAGE_SIZE+'&page='+page;
      const response=ghJson(query);
      if(!Array.isArray(response.workflow_runs)||
         response.workflow_runs.length>PAGE_SIZE||
         !Number.isSafeInteger(response.total_count)||response.total_count<0)
        fail('unbounded/malformed workflow run page '+source.file+'/'+page);
      const runs=response.workflow_runs;
      for(const run of runs){
        if(++listed>MAX_SOURCE_RUNS){
          truncation.push({source_workflow_key:source.key,reason:'source run ceiling',
            page,limit:MAX_SOURCE_RUNS});done=true;break;
        }
        if(artifactCalls>=MAX_ARTIFACT_CALLS){
          records.push({source_workflow_key:source.key,telemetry_group_id:source.group_id,
            run_id:run.id,run_attempt:run.run_attempt,status:'unscanned',
            reason:'bounded GitHub Artifact API budget exhausted'});
          totals.unscanned++;
          continue;
        }
        const key=source.group_id+'/'+run.id+'/'+run.run_attempt;
        const count=stored.get(key)??0;
        // Invalid/foreign sources must not cause further Artifact requests.
        let artifacts={total_count:0,artifacts:[]};
        if(run?.repository?.full_name===REPO &&
           run?.head_repository?.full_name===REPO &&
           run?.path===source.path&&positive(run?.run_attempt)){
          artifacts=ghJson('actions/runs/'+run.id+'/artifacts?per_page='+ARTIFACT_PAGE_SIZE);
          artifactCalls++;
        }
        const status=classifyHistoryRun(run,source,artifacts,count,dateEnd.getTime());
        totals[status.status]++;
        records.push({
          source_workflow_key:source.key,
          telemetry_group_id:source.group_id,
          run_id:run.id,run_attempt:run.run_attempt,
          source_sha:SHA.test(run?.head_sha??'')?run.head_sha:null,
          source_event:run.event??null,created_at:run.created_at??null,
          conclusion:run.conclusion??null,
          source_url:'https://github.com/'+REPO+'/actions/runs/'+run.id,
          ...status,
          ...(run.run_attempt>1?{earlier_attempts_unobserved:true}:{}),
        });
      }
      if(done)break;
      if(runs.length<PAGE_SIZE||response.total_count<=page*PAGE_SIZE){done=true;break;}
      if(page===MAX_PAGES_PER_SOURCE)
        truncation.push({source_workflow_key:source.key,
          reason:'GitHub workflow history exceeds bounded pagination',
          total_count:response.total_count,max_pages:MAX_PAGES_PER_SOURCE});
    }
    if(done&&listed>MAX_SOURCE_RUNS)break;
  }
  if(totals.unscanned)
    truncation.push({reason:'Artifact API budget exhausted',max_calls:MAX_ARTIFACT_CALLS});
  if(records.some(r=>r.earlier_attempts_unobserved))
    truncation.push({reason:'prior rerun attempts require independent attempt-scoped inventory'});
  const report={
    schema_version:1,kind:'agent_telemetry_historical_inventory',
    repository:REPO,generated_at:end,window:{start:START,end},
    source_workflow_keys:sources.map(s=>s.key),
    read_only:true,coverage:truncation.length?'partial':'bounded-complete',
    totals:{...totals,listed,artifact_requests:artifactCalls},
    truncation,records,
    limitations:[
      'A completed workflow is not necessarily a model invocation',
      'No Artifact after retention is unknown or expired, not zero usage',
      'Only independently observed immutable summaries count as ingested',
      'Historical rerun attempts and pages outside the bounded budget are explicitly unobserved',
      'This report is read-only; only trusted Metrics Ingest may recover eligible Artifacts',
    ],
  };
  const bytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  if(bytes.length>MAX_OUTPUT_BYTES)fail('historical inventory exceeds bounded output');
  fs.writeFileSync(output,bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:report.coverage,window:report.window,
    totals:report.totals,truncation:report.truncation},null,2));
}
function selfTest(){
  const source=sourceCatalog().find(x=>x.key==='agent-issue-audit');
  assert.ok(source);
  const run={id:123,run_attempt:1,head_sha:'a'.repeat(40),
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    path:source.path,event:'issues',head_branch:'main',
    status:'completed',conclusion:'success',created_at:'2026-11-20T00:00:00Z',
    name:'Issue Audit #123'};
  const now=Date.parse('2026-11-23T00:00:00Z');
  const artifact={id:456,name:'agent-telemetry-fixture-123-1',
    size_in_bytes:100,expired:false};
  const list={total_count:1,artifacts:[artifact]};
  const classify=(r,l,n=0,t=now)=>classifyHistoryRun(r,source,l,n,t);
  assert.equal(classify(run,list).status,'missing');
  assert.equal(classify(run,list,1).status,'ingested');
  assert.equal(classify(run,{total_count:1,artifacts:[{...artifact,expired:true}]})
    .status,'expired');
  assert.equal(classify(run,{total_count:0,artifacts:[]}).status,'no_artifact_observed');
  assert.equal(classify(run,{total_count:0,artifacts:[]},0,now+21*86400000)
    .status,'unobserved_or_expired');
  assert.equal(classify(run,list,2).status,'ingested');
  assert.equal(classify(run,{total_count:2,artifacts:[artifact,artifact]}).status,'invalid');
  assert.equal(classify({...run,path:'.github/workflows/evil.yml'},list).status,'invalid');
  assert.equal(classify({...run,head_repository:{full_name:'attacker/nession'}},
    list).status,'invalid');
  assert.equal(classify({...run,head_branch:'feature'},list).status,'invalid');
  assert.equal(classify({...run,event:'pull_request'},list).status,'invalid');
  assert.equal(classify({...run,run_attempt:0},list).status,'invalid');
  assert.equal(validateHistoryContext({GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'schedule'}),true);
  assert.throws(()=>validateHistoryContext({GITHUB_REPOSITORY:REPO,
    GITHUB_REF:'refs/heads/feature',GITHUB_EVENT_NAME:'workflow_dispatch'}),
    /protected main/);
  console.log('Agent telemetry historical inventory: provenance, expired, retained, missing, no-model unknown and bounded report self-tests passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='audit'&&process.argv[3]&&process.argv[4])
    scan(process.argv[3],process.argv[4]);
  else fail('usage: self-test | audit ABS_METRICS_STORE ABS_OUTPUT_JSON');
}
