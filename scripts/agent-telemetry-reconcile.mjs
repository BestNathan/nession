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
import {telemetryWorkflowSources,upstreamWorkflowNames} from './workflow-conventions.mjs';
import {validateTelemetrySourceRun} from './agent-workflow-telemetry-contract.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const MAX_RUNS=100, MAX_ARTIFACTS=100, MAX_BYTES=1024*1024;
// All source keys, paths, groups and events come from the canonical Catalog.
// Provider is prioritized to avoid stranding a post-Store Acceptance wake.
const SOURCES=Object.freeze(telemetryWorkflowSources()
  .map(x=>Object.freeze({key:x.key,file:x.file,name:x.name,id:x.group_id,
    events:x.events,branches:x.branches}))
  .sort((a,b)=>Number(b.key==='agent-provider-smoke')-
               Number(a.key==='agent-provider-smoke')));

function fail(message){throw Error('Agent telemetry reconciliation: '+message);}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
export function trustedSource(run,source){
  if(!run||typeof run!=='object'||Array.isArray(run))return false;
  if(!positive(run.id)||!positive(run.run_attempt)||!SHA.test(run.head_sha??'')||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     run.path!=='.github/workflows/'+source.file||
     run.status!=='completed'||!['success','failure'].includes(run.conclusion)||
     !source.events.includes(run.event))return false;
  // Agent source workflows with credentials must be pinned to main. The
  // orchestrator may verify a PR head, but its source workflow is trusted main.
  if(source.file!=='acceptance-orchestrator.yml' && run.head_branch!=='main')return false;
  if(run.event==='push'&&!source.branches.includes(run.head_branch))return false;
  try {
    const verified=validateTelemetrySourceRun(run,REPO);
    return verified.source_workflow_key===source.key &&
      verified.workflow_id===source.id;
  } catch {
    return false;
  }
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
  // Three Acceptance sources intentionally share one Metrics group; scan its
  // immutable directory exactly once, not once for each source.
  const visitedGroups=new Set();
  for(const source of SOURCES){
    if(visitedGroups.has(source.id))continue;
    visitedGroups.add(source.id);
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
export async function chooseMissing(runsBySource,summaryCounts,artifactCount,rotation=0){
  // Round-robin starting source on each scheduled tick, oldest first WITHIN
  // each source. A permanently backlogged Provider must not starve Audit.
  if(!Number.isSafeInteger(rotation)||rotation<0)fail('invalid recovery rotation');
  const offset=rotation%SOURCES.length;
  const orderedSources=[...SOURCES.slice(offset),...SOURCES.slice(0,offset)];
  for(const source of orderedSources){
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
// #4342 SC-05: bounded cross-page recovery of the historical 2026-11-09 gap.
// The schedule rotates exactly one Catalog source, one historical page and at
// most 12 attempt-scoped artifact queries per tick. No caller-selected ref,
// source, date or SHA obtains the Metrics writer; normal recent replay remains.
export const HISTORY_START='2026-11-09';
const HISTORY_PROBE_LIMIT=12;
export function historicalPagePlan(total,runNumber,sourceCount=SOURCES.length){
  if(!Number.isSafeInteger(total)||total<0||!positive(runNumber)||
     !positive(sourceCount))fail('invalid historical scan bounds');
  const source_index=(runNumber-1)%sourceCount;
  const iteration=Math.floor((runNumber-1)/sourceCount);
  const page_count=Math.ceil(total/MAX_RUNS);
  if(!page_count)return {source_index,page:null,offset:0,page_count:0,truncated:false};
  // The historical window's oldest pages get sampled first; explicitly
  // announce any portion beyond the per-source 50-page audit budget.
  const budget=Math.min(page_count,50);
  const page=page_count-(iteration%budget);
  const offset=(Math.floor(iteration/budget)%Math.ceil(MAX_RUNS/HISTORY_PROBE_LIMIT))*
    HISTORY_PROBE_LIMIT;
  return {source_index,page,offset,page_count,truncated:page_count>budget};
}
export function classifyHistoricalArtifact(run,source,listing,recorded){
  if(!trustedSource(run,source))return {status:'invalid_source',published:0,recorded};
  if(!Number.isSafeInteger(recorded)||recorded<0)fail('invalid stored count');
  let published;
  try{published=countArtifactSummaries(listing,run);}
  catch{return {status:'invalid_artifact',published:0,recorded};}
  if(published>recorded)return {status:'missing_recoverable',published,recorded};
  // A formerly persisted source remains already-stored even when GitHub
  // subsequently expires its original Artifact ZIP. The immutable Git bytes
  // are authoritative for stored history; expiration cannot erase that proof.
  if(recorded>0||published>0)
    return {status:'already_stored',published,recorded};
  const suffix='-'+run.id+'-'+run.run_attempt;
  const relevant=listing.artifacts.filter(a=>typeof a.name==='string'&&
    a.name.startsWith('agent-telemetry-')&&a.name.endsWith(suffix));
  if(relevant.some(a=>a.expired===true))
    return {status:'expired_unrecoverable',published:0,recorded};
  // No currently listed Artifact is NOT proof that no Agent ever ran.
  // This state deliberately covers no-model and an expired/unlisted ZIP.
  return {status:'unobserved_no_artifact',published:0,recorded};
}
export async function scanHistoricalScope({source,runNumber,summaryCounts,listing,artifacts}){
  if(!source||!positive(runNumber)||!(summaryCounts instanceof Map)||
     typeof listing!=='function'||typeof artifacts!=='function')
    fail('invalid historical scan context');
  const end=new Date().toISOString().slice(0,10);
  if(end<HISTORY_START)fail('historical scan before start');
  const query='actions/workflows/'+source.file+'/runs?status=completed&created='+
    HISTORY_START+'..'+end+'&per_page='+MAX_RUNS;
  const first=await listing(query+'&page=1');
  if(!Number.isSafeInteger(first?.total_count)||first.total_count<0||
     !Array.isArray(first.workflow_runs)||first.workflow_runs.length>MAX_RUNS)
    fail('untrusted historical workflow inventory');
  const plan=historicalPagePlan(first.total_count,runNumber);
  const pageData=plan.page===null?{workflow_runs:[]}:
    plan.page===1?first:await listing(query+'&page='+plan.page);
  const runs=pageData.workflow_runs;
  if(!Array.isArray(runs)||runs.length>MAX_RUNS)
    fail('unbounded historical workflow page');
  const sampled=runs.slice(plan.offset,plan.offset+HISTORY_PROBE_LIMIT);
  const observations=[];
  let selected=null;
  for(const run of sampled){
    const key=source.id+'/'+run.id+'/'+run.run_attempt;
    const recorded=summaryCounts.get(key)??0;
    let classification;
    if(!trustedSource(run,source) ||
       !Number.isFinite(Date.parse(run.created_at??'')) ||
       run.created_at.slice(0,10)<HISTORY_START ||
       run.created_at.slice(0,10)>end){
      classification={status:'invalid_source',published:0,recorded};
    }else{
      let result;
      try{result=await artifacts(run);}
      catch{classification={status:'invalid_artifact',published:0,recorded};}
      if(result)classification=classifyHistoricalArtifact(run,source,result,recorded);
    }
    observations.push({run_id:run.id,attempt:run.run_attempt,
      source_sha:run.head_sha,status:classification.status,
      published:classification.published,recorded:classification.recorded});
    if(!selected&&classification.status==='missing_recoverable')
      selected={run_id:run.id,run_attempt:run.run_attempt,source_path:run.path,
        target_sha:run.head_sha,recorded,published:classification.published};
  }
  return {schema_version:1,kind:'agent_metrics_historical_recovery_scope',
    created_at:new Date().toISOString(),repository:REPO,start_date:HISTORY_START,
    end_date:end,source_workflow_key:source.key,telemetry_group_id:source.id,
    workflow_path:'.github/workflows/'+source.file,
    page:plan.page,total_pages:plan.page_count,page_offset:plan.offset,
    total_runs_in_date_window:first.total_count,
    truncated:plan.truncated,probe_limit:HISTORY_PROBE_LIMIT,
    observations,
    counts:Object.fromEntries(['invalid_source','invalid_artifact','already_stored',
      'missing_recoverable','expired_unrecoverable','unobserved_no_artifact']
      .map(status=>[status,observations.filter(item=>item.status===status).length])),
    selected,selected_persisted:false,recovered_count:0};
}
export function finalizeHistoricalReport(report,summaryCounts){
  if(report?.kind!=='agent_metrics_historical_recovery_scope'||
     !(summaryCounts instanceof Map))fail('invalid historical finalization');
  const picked=report.selected;
  if(!picked)return {...report,selected_persisted:false,recovered_count:0};
  const key=report.telemetry_group_id+'/'+picked.run_id+'/'+picked.run_attempt;
  const persisted=(summaryCounts.get(key)??0)>=picked.published;
  return {...report,selected_persisted:persisted,recovered_count:persisted?1:0};
}

export function validateReconciliationContext(env,event=null){
  if(env.GITHUB_REPOSITORY!==REPO||
     env.GITHUB_REF!=='refs/heads/main')
    fail('reconciler must execute only on trusted main');
  if(env.GITHUB_EVENT_NAME==='schedule')return 'schedule';
  // GitHub may drop scheduled events under heavy load. A *writer* which
  // successfully persisted a real source can request exactly one bot wake;
  // never accept a public, user-ref-selected workflow_dispatch fallback.
  if(env.GITHUB_EVENT_NAME==='repository_dispatch' &&
     env.GITHUB_ACTOR==='github-actions[bot]'&&
     event?.action==='nession-agent-metrics-history-recover'&&
     event?.sender?.login==='github-actions[bot]'&&
     event?.repository?.full_name===REPO&&
     Number.isSafeInteger(Number(event?.client_payload?.writer_run_id))&&
     Number(event.client_payload.writer_run_id)>0)
    return 'trusted-bot-recovery';
  fail('reconciliation denied: schedule or trusted post-Store bot wake required');
}
// Repository-dispatch's bot identity is necessary, not sufficient: another
// workflow with GITHUB_TOKEN could manufacture the same actor. The immutable
// writer run is independently re-read with the exact attempt and completed
// post-Store steps before a bot wake can enter privileged recovery.
export function attestHistoryWriterWake(run,jobs,event,now=Date.now()){
  const id=Number(event?.client_payload?.writer_run_id);
  if(!positive(id)||run?.id!==id||run.run_attempt!==1||
     run.path!=='.github/workflows/metrics-agent-telemetry.yml'||
     run.event!=='workflow_run'||run.status!=='completed'||run.conclusion!=='success'||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     run.head_branch!=='main'||!SHA.test(run.head_sha??'')||
     !Number.isFinite(Date.parse(run.updated_at??''))||
     now-Date.parse(run.updated_at)>6*60*60*1000||
     Date.parse(run.updated_at)>now+5*60*1000)
    fail('untrusted historical wake writer provenance');
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    fail('unbounded historical wake writer jobs');
  const ingests=jobs.jobs.filter(j=>j.name==='ingest');
  if(ingests.length!==1||ingests[0].run_id!==id||
     ingests[0].run_attempt!==1||ingests[0].conclusion!=='success'||
     ingests[0].status!=='completed')
    fail('untrusted historical wake writer job');
  for(const stepName of ['Validate and append immutable telemetry',
    'Commit metrics history','Verify immutable Git bytes before uploading Run Store receipts']){
    const matching=(ingests[0].steps??[]).filter(step=>
      step.name===stepName&&step.conclusion==='success');
    if(matching.length!==1)fail('historical wake requires real immutable Store write: '+stepName);
  }
  return true;
}
function reconcileEventContext(){
  if(process.env.GITHUB_EVENT_NAME!=='repository_dispatch')return null;
  const file=process.env.GITHUB_EVENT_PATH;
  if(!file||!path.isAbsolute(file))fail('GitHub event payload file required');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
async function select(store){
  const event=reconcileEventContext();
  const context=validateReconciliationContext(process.env,event);
  if(context==='trusted-bot-recovery'){
    const id=Number(event.client_payload.writer_run_id);
    const run=ghJson('actions/runs/'+id);
    const jobs=ghJson('actions/runs/'+id+'/attempts/1/jobs?per_page=100');
    attestHistoryWriterWake(run,jobs,event);
  }
  if(!path.isAbsolute(store))fail('absolute trusted Metrics Store path required');
  const summaryCounts=indexedSourceSummaries(store);
  const runNumber=Number(process.env.GITHUB_RUN_NUMBER);
  if(!positive(runNumber))fail('trusted schedule run_number required for fairness');
  const source=SOURCES[(runNumber-1)%SOURCES.length];
  const report=await scanHistoricalScope({source,runNumber,summaryCounts,
    listing:async endpoint=>ghJson(endpoint),
    artifacts:async run=>ghJson('actions/runs/'+run.id+'/artifacts?per_page='+MAX_ARTIFACTS)});
  const reportPath=process.env.RECOVERY_REPORT_PATH;
  if(!path.isAbsolute(reportPath??'')||!reportPath.endsWith('.json'))
    fail('absolute historical report output required');
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  // Prioritize the selected authentic gap source; ordinary 14-source bounded
  // discovery still runs when no old missing artifact was observed.
  let result=report.selected;
  if(!result){
    const runsBySource=new Map();
    for(const candidate of SOURCES){
      const response=ghJson('actions/workflows/'+candidate.file+
        '/runs?status=completed&per_page='+MAX_RUNS);
      if(!Array.isArray(response.workflow_runs))fail('malformed workflow run listing');
      runsBySource.set(candidate.file,response.workflow_runs);
    }
    result=await chooseMissing(runsBySource,summaryCounts,async run=>{
      const artifacts=ghJson('actions/runs/'+run.id+'/artifacts?per_page='+MAX_ARTIFACTS);
      return countArtifactSummaries(artifacts,run);
    },runNumber%SOURCES.length);
  }
  console.log(JSON.stringify(result??{run_id:null}));
}
function finalize(store,reportPath){
  validateReconciliationContext(process.env,reconcileEventContext());
  if(!path.isAbsolute(store)||!path.isAbsolute(reportPath))fail('absolute finalization paths required');
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  fs.writeFileSync(reportPath,JSON.stringify(
    finalizeHistoricalReport(report,indexedSourceSummaries(store)),null,2)+'\n');
}
// The scheduled replay is allowed only through trusted main-selected workflow
// code; an arbitrary-ref workflow_dispatch cannot obtain the metrics writer.
export function validateRecoveryRouting(workflow){
  const trigger=workflow.split(/^permissions:/m)[0];
  const job=workflow.split(/^jobs:/m)[1]??'';
  if(!/^  schedule:\s*\n    - cron: '[^'\n]+'\s*$/m.test(trigger) ||
     /^  workflow_dispatch:/m.test(trigger))
    fail('Metrics replay must remain main-owned; no arbitrary-ref dispatch');
  if(!job.includes("github.event_name == 'schedule' && github.ref == 'refs/heads/main'")||
     !job.includes("github.repository == 'BestNathan/nession'"))
    fail('missing trusted main schedule guard');
  // GitHub workflow_run.workflows uses static top-level display names *only*
  // as event subscriptions; compare that list with the Catalog projection.
  const subscribers=upstreamWorkflowNames(workflow);
  const expectedNames=SOURCES.map(source=>source.name);
  if(!subscribers.valid || subscribers.names.length!==expectedNames.length ||
     new Set(subscribers.names).size!==expectedNames.length ||
     subscribers.names.some(name=>!expectedNames.includes(name)))
    fail('Metrics workflow_run subscriptions drifted from Catalog sources');
  // Display names are never runtime authority; authenticated path+event/ref
  // policy is checked again by the main-owned provenance script.
  if(job.includes('github.event.workflow_run.name =='))
    fail('runtime source display-name authorization is forbidden');
  for(const source of SOURCES){
    if(!trigger.includes('      - '+source.name)||
       !job.includes("github.event.workflow_run.path == '.github/workflows/"+source.file+"'"))
      fail('unclassified or unregistered Agent source: '+source.name);
  }
  if(!workflow.includes('node scripts/agent-telemetry-reconcile.mjs select')||
     !workflow.includes('run-store-integrity.mjs"'))
    fail('trusted reconciliation or immutable Store Gate omitted');
  if(!job.includes("- name: Select missed trusted Agent telemetry source\n        if: github.event_name == 'schedule' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-metrics-history-recover')")||
     !job.includes("- name: Checkout metrics history\n        if: github.event_name == 'schedule' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-metrics-history-recover') || steps.event_artifacts.outputs.count != '0'")||
     !job.includes("if: ((github.event_name == 'workflow_run' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-review-completed')) && steps.event_artifacts.outputs.count != '' && steps.event_artifacts.outputs.count != '0') || steps.reconcile.outputs.run_id != ''")||
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
     !job.includes('EVENT_RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt || github.event.client_payload.source_run_attempt }}') ||
     !job.includes('RUN_ATTEMPT: ${{ steps.source.outputs.run_attempt }}') ||
     !job.includes('--pattern "agent-telemetry-*-${RUN_ID}-${RUN_ATTEMPT}"'))
    fail('source attempt-scoped telemetry discovery/download is required');
  // Only Reviewer dispatch accepts sender-selected source metadata; a history
  // wake selects a source independently, and an empty history scan is a no-op.
  if(!job.includes('EVENT_DISPATCH_ACTION: ${{ github.event.action }}')||
     !job.includes("if [[ \"$GITHUB_EVENT_NAME\" == repository_dispatch &&\n                \"$EVENT_DISPATCH_ACTION\" == nession-agent-review-completed ]]; then"))
    fail('Reviewer-specific dispatch guard must exclude historical recovery');
  const reviewerGuard=[
    "(github.event_name == 'repository_dispatch' &&",
    "          github.ref == 'refs/heads/main' &&",
    "          github.event.action == 'nession-agent-review-completed' &&",
    "          github.actor == 'github-actions[bot]' &&",
    "          github.event.sender.login == 'github-actions[bot]')",
  ].join('\n');
  if(!trigger.includes('    types: [nession-agent-review-completed, nession-agent-metrics-history-recover]') ||
     !job.includes(reviewerGuard) ||
     !job.includes("github.event.action == 'nession-agent-review-completed'") ||
     !job.includes("github.actor == 'github-actions[bot]'") ||
     !job.includes("github.event.sender.login == 'github-actions[bot]'") ||
     !job.includes("github.event_name == 'repository_dispatch'") ||
     !job.includes('EVENT_SOURCE_SHA: ${{ github.event.client_payload.source_sha }}') ||
     !job.includes('.head_sha == $sha') ||
     !job.includes('.run_attempt == $attempt') ||
     !job.includes('.path == ".github/workflows/agent-review.yml"') ||
     !job.includes('event == "workflow_dispatch"') ||
     !/^\s+sleep 3\s*$/m.test(job))
    fail('untrusted or unbounded bot Reviewer Metrics wake');
  if(!workflow.includes("github.event.workflow_run.event == 'push'") ||
     !workflow.includes("github.event.workflow_run.event == 'pull_request_target'"))
    fail('source event routing omitted');
  // The emergency history wake is a *main-owned* bot signal, not public
  // workflow_dispatch. The same writer re-authenticates the selected source.
  const botGuard=[
    "(github.event_name == 'repository_dispatch' &&",
    "          github.ref == 'refs/heads/main' &&",
    "          github.event.action == 'nession-agent-metrics-history-recover' &&",
    "          github.actor == 'github-actions[bot]' &&",
    "          github.event.sender.login == 'github-actions[bot]')",
  ].join('\n');
  if(!trigger.includes('nession-agent-metrics-history-recover')||
     !job.includes(botGuard)||
     !job.includes("github.event_name == 'workflow_run' &&\n          steps.persist.outputs.changed != ''")||
     !job.includes('client_payload[writer_run_id]=${GITHUB_RUN_ID}')||
     !job.includes('if: github.event_name == \'workflow_run\' || (github.event_name == \'repository_dispatch\' && github.event.action == \'nession-agent-review-completed\')'))
    fail('untrusted or recursive Metrics history bot wake');
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
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    '"$EVENT_DISPATCH_ACTION" == nession-agent-review-completed ]]; then',
    '"$EVENT_DISPATCH_ACTION" == nession-agent-metrics-history-recover ]]; then'
  )),/Reviewer-specific dispatch guard/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    '      - Agent / Issue Audit',
    '      - Attacker / Source'
  )),/subscriptions drifted from Catalog/);
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    '      - Agent / Issue Audit\n',''
  )),/subscriptions drifted from Catalog/);
  for(const weaker of [
    workflow.replace("github.event.action == 'nession-agent-metrics-history-recover'",
      "github.event.action == 'attacker-recover'"),
    workflow.replace('client_payload[writer_run_id]=${GITHUB_RUN_ID}',
      'client_payload[writer_run_id]=attacker'),
    workflow.replace("github.event_name == 'workflow_run' &&\n          steps.persist.outputs.changed != ''",
      "github.event_name == 'repository_dispatch' &&\n          steps.persist.outputs.changed != ''"),
  ])assert.throws(()=>validateRecoveryRouting(weaker),
    /untrusted or recursive Metrics history bot wake|empty telemetry events/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("  schedule:\n", "  workflow_dispatch:\n  schedule:\n")
  ),/main-owned/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("github.event_name == 'schedule' && github.ref == 'refs/heads/main'",
      "github.event_name == 'schedule'")
  ),/trusted main/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("node scripts/agent-telemetry-reconcile.mjs select", "echo skip")
  ),/Gate omitted/);
  for(const candidate of [
    workflow.replace("github.event.sender.login == 'github-actions[bot]'",
      "github.event.sender.login == 'attacker'"),
    workflow.replace('EVENT_SOURCE_SHA: ${{ github.event.client_payload.source_sha }}',
      'EVENT_SOURCE_SHA: trusted'),
    workflow.replace('sleep 3', 'sleep 300'),
  ])assert.throws(()=>validateRecoveryRouting(candidate),
    /untrusted or unbounded bot Reviewer Metrics wake/);
  assert.throws(()=>validateRecoveryRouting(
    workflow.replace("Verified failed Provider telemetry archived; no success-only Acceptance wake",
      "Always wake Acceptance irrespective of Provider conclusion")
  ),/failed Provider evidence/);
    const mainEnv={GITHUB_REPOSITORY:REPO,GITHUB_REF:'refs/heads/main'};
  assert.equal(validateReconciliationContext({...mainEnv,GITHUB_EVENT_NAME:'schedule'}),'schedule');
  const writerRun={id:45168056749,run_attempt:1,
    path:'.github/workflows/metrics-agent-telemetry.yml',
    name:'Metrics / Agent Telemetry Ingest',event:'workflow_run',
    status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    head_branch:'main',head_sha:'a'.repeat(40),
    updated_at:'2026-11-23T12:00:00Z'};
  const writerJobs={jobs:[{name:'ingest',run_id:writerRun.id,run_attempt:1,
    status:'completed',conclusion:'success',steps:[
      'Validate and append immutable telemetry','Commit metrics history',
      'Verify immutable Git bytes before uploading Run Store receipts',
    ].map(name=>({name,conclusion:'success'}))}]};
  const botEvent={action:'nession-agent-metrics-history-recover',
    sender:{login:'github-actions[bot]'},repository:{full_name:REPO},
    client_payload:{writer_run_id:45168056749}};
  assert.equal(validateReconciliationContext({...mainEnv,
    GITHUB_EVENT_NAME:'repository_dispatch',GITHUB_ACTOR:'github-actions[bot]'},botEvent),
    'trusted-bot-recovery');
  assert.equal(attestHistoryWriterWake(writerRun,writerJobs,botEvent,
    Date.parse('2026-11-23T12:05:00Z')),true);
  assert.equal(attestHistoryWriterWake({...writerRun,name:'Dynamic display #4342'},
    writerJobs,botEvent,Date.parse('2026-11-23T12:05:00Z')),true,
    'display name must never become writer authorization identity');
  for(const [badRun,badJobs] of [
    [{...writerRun,path:'.github/workflows/evil.yml'},writerJobs],
    [{...writerRun,event:'workflow_dispatch'},writerJobs],
    [{...writerRun,conclusion:'failure'},writerJobs],
    [writerRun,{jobs:[{...writerJobs.jobs[0],steps:writerJobs.jobs[0].steps
      .filter(step=>step.name!=='Commit metrics history')}]}],
  ])assert.throws(()=>attestHistoryWriterWake(badRun,badJobs,botEvent,
      Date.parse('2026-11-23T12:05:00Z')),/untrusted historical wake|real immutable Store write/);
  assert.throws(()=>attestHistoryWriterWake(writerRun,writerJobs,botEvent,
    Date.parse('2026-11-24T12:05:00Z')),/untrusted historical wake/);
  for(const [badEnv,badEvent] of [
    [{...mainEnv,GITHUB_EVENT_NAME:'repository_dispatch',
      GITHUB_ACTOR:'attacker'},botEvent],
    [{...mainEnv,GITHUB_EVENT_NAME:'repository_dispatch',
      GITHUB_ACTOR:'github-actions[bot]'},{
        ...botEvent,sender:{login:'attacker'}}],
    [{...mainEnv,GITHUB_EVENT_NAME:'repository_dispatch',
      GITHUB_ACTOR:'github-actions[bot]'},{
        ...botEvent,action:'nession-agent-review-completed'}],
    [{...mainEnv,GITHUB_EVENT_NAME:'repository_dispatch',
      GITHUB_ACTOR:'github-actions[bot]'},{
        ...botEvent,client_payload:{writer_run_id:0}}],
  ])assert.throws(()=>validateReconciliationContext(badEnv,badEvent),
    /reconciliation denied/);
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
    "github.event_name == 'schedule' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-metrics-history-recover') || steps.event_artifacts.outputs.count != '0'",
    "github.event_name == 'schedule' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-metrics-history-recover') || steps.event_artifacts.outputs.count == '0'"
  )),/empty telemetry events/);
  // Empty telemetry must not proceed through source resolution after preflight.
  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "if: ((github.event_name == 'workflow_run' || (github.event_name == 'repository_dispatch' && github.event.action == 'nession-agent-review-completed')) && steps.event_artifacts.outputs.count != '' && steps.event_artifacts.outputs.count != '0') || steps.reconcile.outputs.run_id != ''",
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


  assert.throws(()=>validateRecoveryRouting(workflow.replace(
    "github.event.workflow_run.path == '.github/workflows/agent-issue-audit.yml'",
    "github.event.workflow_run.name == 'Agent / Issue Audit'"
  )),/display-name authorization/);

  const source=SOURCES[0],sha='a'.repeat(40);
  const run={id:321,run_attempt:1,head_sha:sha,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    path:'.github/workflows/'+source.file,name:source.name,
    status:'completed',conclusion:'success',event:'push',head_branch:'main',
    created_at:'2026-10-14T00:00:00Z'};
  assert.equal(trustedSource(run,source),true);
  assert.equal(SOURCES.length,14);
  assert.equal(new Set(SOURCES.map(s=>s.file)).size,14);
  assert.equal(SOURCES.filter(s=>s.id==='requirement-acceptance').length,3);
  assert.equal(SOURCES[0].key,'agent-provider-smoke');
  assert.deepEqual(historicalPagePlan(0,1),{source_index:0,page:null,
    offset:0,page_count:0,truncated:false});
  assert.equal(historicalPagePlan(250,1).page,3);
  assert.equal(historicalPagePlan(250,1+SOURCES.length).page,2);
  assert.equal(historicalPagePlan(250,1+3*SOURCES.length).offset,12);
  const historicalSample=classifyHistoricalArtifact(run,source,
    {total_count:1,artifacts:[{name:'agent-telemetry-test-321-1',
       size_in_bytes:100,expired:true}]},0);
  assert.equal(historicalSample.status,'expired_unrecoverable');
  assert.equal(classifyHistoricalArtifact(run,source,
    {total_count:1,artifacts:[{name:'agent-telemetry-test-321-1',
      size_in_bytes:100,expired:true}]},1).status,'already_stored');
  assert.equal(classifyHistoricalArtifact(run,source,
    {total_count:0,artifacts:[]},0).status,'unobserved_no_artifact');
  assert.equal(finalizeHistoricalReport({kind:'agent_metrics_historical_recovery_scope',
    telemetry_group_id:source.id,selected:{run_id:321,run_attempt:1,published:1}},
    new Map([[source.id+'/321/1',1]])).selected_persisted,true);
  const auditSource=SOURCES.find(item=>item.file==='agent-issue-audit.yml');
  assert.ok(auditSource);
  for(const [name,event] of [
    ['Issue Audit #4297','issues'],
    ['Comment Audit #4230 comment:7090927541','workflow_dispatch'],
  ]){
    const auditRun={...run,path:'.github/workflows/'+auditSource.file,
      name,event};
    assert.equal(trustedSource(auditRun,auditSource),true);
    assert.equal(trustedSource({...auditRun,head_repository:{full_name:'attacker/fork'}},auditSource),false);
    assert.equal(trustedSource({...auditRun,path:'.github/workflows/evil.yml'},auditSource),false);
    assert.equal(trustedSource({...auditRun,head_branch:'feature'},auditSource),false);
  }
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
    const nextSource=SOURCES[1];
    const alternate={...run,id:400,path:'.github/workflows/'+nextSource.file,
      name:nextSource.name,event:nextSource.events[0]};
    const rotationRuns=new Map([[source.file,[run]],[nextSource.file,[alternate]]]);
    const historical=await scanHistoricalScope({
      source,runNumber:1,summaryCounts:new Map(),
      listing:async query=>({total_count:1,workflow_runs:[{...run,
        created_at:'2026-11-10T00:00:00Z'}]}),
      artifacts:async()=>({total_count:1,artifacts:[{...attempt1}]}),
    });
    assert.equal(historical.selected.run_id,321);
    assert.equal(historical.counts.missing_recoverable,1);
    assert.equal(historical.counts.expired_unrecoverable,0);
    assert.equal((await chooseMissing(rotationRuns,new Map(),async()=>1,1)).run_id,400,
      'round-robin recovery must not permanently prioritize Provider');
    await assert.rejects(()=>chooseMissing(rotationRuns,new Map(),async()=>1,-1),
      /invalid recovery rotation/);
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
    cmd==='history-finalize'?Promise.resolve().then(()=>finalize(process.argv[3],process.argv[4])):
    cmd==='artifact-count'?Promise.resolve().then(()=>{
      const [file,id,attempt]=process.argv.slice(3);
      if(!file || !/^[1-9][0-9]*$/.test(id??'') || !/^[1-9][0-9]*$/.test(attempt??''))
        fail('usage: artifact-count GITHUB_ARTIFACTS_JSON SOURCE_RUN_ID RUN_ATTEMPT');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      console.log(countArtifactSummaries(data,{id:Number(id),run_attempt:Number(attempt)}));
    }):Promise.reject(Error('usage: self-test | select ABS_METRICS_DIR | artifact-count GITHUB_ARTIFACTS_JSON RUN_ID ATTEMPT'));
  operation.catch(e=>{console.error(e.message);process.exitCode=1;});
}
