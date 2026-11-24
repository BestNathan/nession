#!/usr/bin/env node
// #4342 SC-05: read-only attestation of an ACTUAL main-owned historical
// Metrics recovery Run, Artifact, original source, and immutable Store bytes.
// Never infer completion from source code, a green Run, or a model conclusion.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {telemetryWorkflowSources} from './workflow-conventions.mjs';
import {trustedSource,countArtifactSummaries,indexedSourceSummaries}
  from './agent-telemetry-reconcile.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
const START='2026-11-09';
const STATUSES=Object.freeze(['invalid_source','invalid_artifact','already_stored',
  'missing_recoverable','expired_unrecoverable','unobserved_no_artifact']);
const sources=new Map(telemetryWorkflowSources().map(x=>[x.key,{
  key:x.key,file:x.file,id:x.group_id,name:x.name,
  events:x.events,branches:x.branches,
}]));
function reject(reason){throw Error('4342 historical Metrics readback: '+reason);}
function positive(n){return Number.isSafeInteger(n)&&n>0;}
function checkGithubRun(run){
  if(!positive(run?.id)||!positive(run?.run_attempt)||!SHA.test(run.head_sha??'')||
     run.repository?.full_name!==REPO||run.head_repository?.full_name!==REPO||
     run.path!=='.github/workflows/metrics-agent-telemetry.yml'||
     run.head_branch!=='main'||run.status!=='completed'||run.conclusion!=='success'||
     !['schedule','repository_dispatch'].includes(run.event)||
     (run.event==='repository_dispatch'&&run.actor?.login!=='github-actions[bot]'))
    reject('untrusted main-owned Metrics history Run');
}
function checkHistoryJob(r,jobs){
  if(!Array.isArray(jobs?.jobs)||jobs.jobs.length>100)
    reject('unbounded history Run job listing');
  const matching=jobs.jobs.filter(j=>j.name==='ingest');
  if(matching.length!==1||matching[0].run_id!==r.id||
     matching[0].run_attempt!==r.run_attempt||
     matching[0].status!=='completed'||matching[0].conclusion!=='success')
    reject('failed or mismatched history ingest job');
  for(const name of ['Select missed trusted Agent telemetry source',
    'Validate and append immutable telemetry','Commit metrics history',
    'Verify immutable Git bytes before uploading Run Store receipts',
    'Finalize bounded historical recovery report',
    'Upload scoped historical recovery and expiry inventory']){
    if((matching[0].steps??[]).filter(s=>s.name===name&&s.conclusion==='success').length!==1)
      reject('missing authentic history write/report step: '+name);
  }
  return matching[0].id;
}
export function attest4342History({writer,jobs,artifact,report,original,
  originalArtifacts,storedCounts,targetSha,ancestry}) {
  checkGithubRun(writer);
  if(!SHA.test(targetSha??'')||ancestry?.writer!==true||
     ancestry?.original!==true)
    reject('accepted target must contain source and historical writer');
  const jobId=checkHistoryJob(writer,jobs);
  const expected='agent-metrics-history-'+writer.id+'-'+writer.run_attempt;
  if(artifact?.name!==expected||!positive(artifact.id)||
     artifact.expired!==false||!positive(artifact.size_in_bytes)||
     artifact.size_in_bytes>1048576||
     artifact.workflow_run?.id!==writer.id)
    reject('missing exact unexpired historical report Artifact');
  if(report?.schema_version!==1||report.kind!=='agent_metrics_historical_recovery_scope'||
     report.repository!==REPO||report.start_date!==START||
     !/^\d{4}-\d{2}-\d{2}$/.test(report.end_date??'')||
     report.end_date<START||
     !Number.isFinite(Date.parse(report.created_at??''))||
     !positive(report.page)||!positive(report.total_pages)||
     report.page>report.total_pages||
     !Number.isSafeInteger(report.page_offset)||report.page_offset<0||
     report.page_offset%12!==0||report.probe_limit!==12||
     !Number.isSafeInteger(report.total_runs_in_date_window)||
     report.total_runs_in_date_window<1||
     !['boolean'].includes(typeof report.truncated))
    reject('untrusted bounded history scope');
  const source=sources.get(report.source_workflow_key);
  if(!source||report.telemetry_group_id!==source.id||
     report.workflow_path!=='.github/workflows/'+source.file)
    reject('history source is not the canonical Catalog projection');
  if(!Array.isArray(report.observations)||report.observations.length>12||
     !report.observations.length||!report.counts||
     typeof report.counts!=='object'||Array.isArray(report.counts))
    reject('unbounded/missing history observations');
  const tally=Object.fromEntries(STATUSES.map(status=>[status,0]));
  for(const entry of report.observations){
    if(!positive(entry.run_id)||!positive(entry.attempt)||
       !SHA.test(entry.source_sha??'')||
       !Number.isSafeInteger(entry.published)||entry.published<0||
       !Number.isSafeInteger(entry.recorded)||entry.recorded<0||
       !Object.hasOwn(tally,entry.status))
      reject('invalid observed history identity/status');
    tally[entry.status]++;
  }
  if(Object.keys(report.counts).length!==STATUSES.length||
     STATUSES.some(status=>report.counts[status]!==tally[status]))
    reject('history reported status totals do not match observations');
  const chosen=report.selected;
  if(!chosen||!positive(chosen.run_id)||!positive(chosen.run_attempt)||
     !SHA.test(chosen.target_sha??'')||
     chosen.source_path!=='.github/workflows/'+source.file||
     !positive(chosen.published)||!Number.isSafeInteger(chosen.recorded)||
     chosen.recorded<0||chosen.published<=chosen.recorded||
     report.selected_persisted!==true||report.recovered_count!==1)
    reject('no selected and durably persisted missing artifact');
  const selected=report.observations.filter(o=>
    o.run_id===chosen.run_id&&o.attempt===chosen.run_attempt&&
    o.status==='missing_recoverable'&&o.published===chosen.published&&
    o.recorded===chosen.recorded&&o.source_sha===chosen.target_sha);
  if(selected.length!==1)reject('selected run not identified as a real historical gap');
  if(!trustedSource(original,source)||original.id!==chosen.run_id||
     original.run_attempt!==chosen.run_attempt||
     original.head_sha!==chosen.target_sha||
     !Number.isFinite(Date.parse(original.created_at??''))||
     original.created_at.slice(0,10)<START||
     original.created_at.slice(0,10)>report.end_date)
    reject('selected historical source failed GitHub provenance');
  const count=countArtifactSummaries(originalArtifacts,original);
  if(count!==chosen.published)
    reject('original Agent artifact missing, expired, or changed');
  if(!(storedCounts instanceof Map)||
     (storedCounts.get(source.id+'/'+chosen.run_id+'/'+chosen.run_attempt)??0)<chosen.published)
    reject('real immutable Metrics Store does not contain recovered source');
  return Object.freeze({
    kind:'verified_4342_historical_metrics_recovery',status:'authenticated',
    target_sha:targetSha,history_writer_run_id:writer.id,
    history_writer_attempt:writer.run_attempt,history_writer_job_id:jobId,
    report_artifact_id:artifact.id,source_workflow_key:source.key,
    telemetry_group_id:source.id,selected_source_run_id:chosen.run_id,
    selected_source_attempt:chosen.run_attempt,
    selected_source_sha:chosen.target_sha,
    published:chosen.published,formerly_recorded:chosen.recorded,
    recorded_after:storedCounts.get(source.id+'/'+chosen.run_id+'/'+chosen.run_attempt),
    counts:tally,source_scope_start:START,source_scope_end:report.end_date,
    examined:report.observations.length,scope_page:report.page,
    scope_offset:report.page_offset,truncated:report.truncated,
    is_full_gap_census:false,
    note:'Only the single selected source and bounded observations are attested; no full historical census claimed',
  });
}
export function verified4342HistoryCriterion(context,normalized){
  if(Number(context?.issue?.number)!==4342||context.stage!=='post-merge')
    return normalized;
  const item=normalized.criteria?.find(x=>x.criterion==='SC-05');
  if(!item)return normalized;
  const p=context.ci_evidence?.verified_4342_historical_metrics;
  const ok=p?.kind==='verified_4342_historical_metrics_recovery'&&
    p.status==='authenticated'&&p.target_sha===context.target_ref&&
    positive(p.history_writer_run_id)&&positive(p.report_artifact_id)&&
    positive(p.selected_source_run_id)&&p.published>p.formerly_recorded&&
    p.recorded_after>=p.published&&p.source_scope_start===START&&
    p.is_full_gap_census===false;
  if(!ok){
    // A successful static Agent analysis is not runtime recovery evidence.
    // Down-project unsupported Pass to Pending rather than aborting the
    // updater and leaving a stale, previously published false Pass behind.
    if(item.result!=='Pass')return normalized;
    return {...normalized,criteria:normalized.criteria.map(entry=>
      entry.criterion!=='SC-05'?entry:{
        ...entry,result:'Pending',evidence:[],
        summary:'No authenticated main-owned historical recovery Artifact and immutable Store readback; static implementation/tests do not satisfy SC-05',
      })};
  }
  if(item.result==='Fail'||item.result==='N/A')return normalized;
  return {...normalized,criteria:normalized.criteria.map(x=>x.criterion!=='SC-05'?x:{
    ...x,result:'Pass',
    evidence:[{type:'authenticated-history',
      value:'history writer '+p.history_writer_run_id+
        ', Artifact '+p.report_artifact_id+', source '+p.selected_source_run_id+
        '/'+p.selected_source_attempt+', recovered '+p.published+
        ', recorded_before '+p.formerly_recorded+
        ', recorded_after '+p.recorded_after+
        ', statuses '+JSON.stringify(p.counts)+
        '; bounded sample (not full census)'}],
    summary:'One selected genuine historical gap was persisted with independently verified GitHub source, attempt-scoped Artifact, and canonical immutable Store; bounded status/expiry report retained',
  })};
}
function gh(endpoint){
  return JSON.parse(execFileSync('gh',['api','repos/'+REPO+'/'+endpoint],
    {encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}));
}
function ancestor(root,source,target){
  if(!SHA.test(source)||!SHA.test(target))return false;
  try{execFileSync('git',['-C',root,'merge-base','--is-ancestor',source,target],
    {timeout:20000,stdio:'ignore'});return true;}catch{return false;}
}
// A successful bounded scan can legitimately have no selected historical gap.
// Keep searching older authentic reports; a no-op cannot hide an earlier
// actual recovery or be mistaken for a failed Acceptance infrastructure job.
export function hasRecoveredHistoricalSelection(report){
  if(report?.schema_version!==1||
     report.kind!=='agent_metrics_historical_recovery_scope'||
     report.repository!==REPO||report.start_date!==START)
    reject('unexpected historical report envelope');
  return positive(report.selected?.run_id)&&report.selected_persisted===true&&
    report.recovered_count===1;
}
function reportFromArtifact(run,artifact){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nession-4342-history-'));
  try{
    execFileSync('gh',['run','download',String(run.id),'--repo',REPO,
      '--name',artifact.name,'--dir',dir],{
      encoding:'utf8',timeout:60000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
    const name=path.join(dir,'agent-metrics-history.json');
    const meta=fs.lstatSync(name);
    if(!meta.isFile()||meta.isSymbolicLink()||meta.size<2||meta.size>1048576)
      reject('unsafe historical report payload');
    const bytes=fs.readFileSync(name);
    return {report:JSON.parse(bytes.toString('utf8')),
      digest:crypto.createHash('sha256').update(bytes).digest('hex')};
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function collect(file,targetSha){
  if(process.env.GITHUB_REPOSITORY!==REPO||process.env.ACCEPTANCE_STAGE!=='post-merge'||
     String(process.env.ISSUE_NUMBER)!=='4342'||!SHA.test(targetSha))
    reject('collector is not trusted post-merge #4342');
  const workspace=path.join(process.env.GITHUB_WORKSPACE??'','workspace');
  const actual=execFileSync('git',['-C',workspace,'rev-parse','HEAD'],
    {encoding:'utf8',timeout:20000}).trim();
  if(actual!==targetSha)reject('wrong trusted Acceptance target checkout');
  const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
  if(evidence?.kind!=='acceptance_ci_evidence'||evidence.target_sha!==targetSha)
    reject('untrusted CI evidence file');
  const candidates=[];
  for(const event of ['repository_dispatch','schedule']){
    const result=gh('actions/workflows/metrics-agent-telemetry.yml/runs?event='+event+
      '&per_page=100');
    if(!Array.isArray(result?.workflow_runs)||result.workflow_runs.length>100)
      reject('incomplete historical workflow listing');
    candidates.push(...result.workflow_runs.filter(x=>x.event===event));
  }
  candidates.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  // Deliberately bounded search; absent proof is Pending, not zero or Pass.
  let selected=null;
  for(const candidate of candidates.slice(0,40)){
    if(candidate.status!=='completed'||candidate.conclusion!=='success'||
       candidate.head_branch!=='main'||!SHA.test(candidate.head_sha??'')||
       !ancestor(workspace,candidate.head_sha,targetSha))continue;
    const listing=gh('actions/runs/'+candidate.id+'/artifacts?per_page=100');
    if(!Array.isArray(listing?.artifacts)||listing.artifacts.length>100||
       listing.total_count!==listing.artifacts.length)
      reject('incomplete historical Artifact inventory');
    const name='agent-metrics-history-'+candidate.id+'-'+candidate.run_attempt;
    const found=listing.artifacts.filter(a=>a.name===name);
    if(!found.length)continue;
    if(found.length!==1)reject('duplicate historical report Artifact');
    if(found[0].expired===true)continue;
    // Authenticate candidate metadata before downloading anything.
    checkGithubRun(candidate);
    if(found[0].workflow_run?.id!==candidate.id||
       !positive(found[0].id)||!positive(found[0].size_in_bytes)||
       found[0].size_in_bytes>1048576||found[0].expired!==false)
      reject('untrusted historical report Artifact metadata');
    const read=reportFromArtifact(candidate,found[0]);
    if(!hasRecoveredHistoricalSelection(read.report))continue;
    selected={candidate,artifact:found[0],read};
    break;
  }
  if(!selected){
    console.log('No main-owned authenticated historical report yet; SC-05 remains Pending');
    return;
  }
  const writer=gh('actions/runs/'+selected.candidate.id);
  const jobs=gh('actions/runs/'+writer.id+'/attempts/'+writer.run_attempt+'/jobs?per_page=100');
  const read=selected.read;
  const chosen=read.report?.selected;
  if(!positive(chosen?.run_id))reject('selected historical source Run missing');
  const original=gh('actions/runs/'+chosen.run_id);
  const originalArtifacts=gh('actions/runs/'+original.id+'/artifacts?per_page=100');
  const store=path.join(process.env.GITHUB_WORKSPACE??'','provider-metrics');
  if(!path.isAbsolute(store)||!fs.statSync(store).isDirectory())
    reject('read-only Metrics checkout missing');
  const proof=attest4342History({
    writer,jobs,artifact:selected.artifact,report:read.report,original,
    originalArtifacts,storedCounts:indexedSourceSummaries(store),
    targetSha,ancestry:{writer:ancestor(workspace,writer.head_sha,targetSha),
      original:ancestor(workspace,original.head_sha,targetSha)},
  });
  fs.writeFileSync(file,JSON.stringify({...evidence,
    verified_4342_historical_metrics:{...proof,report_sha256:read.digest}},null,2)+'\n');
  console.log('Verified genuine historical Agent source '+proof.selected_source_run_id+
    ' via authenticated Metrics history Run '+proof.history_writer_run_id);
}
// The existing read-only metrics checkout must precede the post-merge
// collector for #4342. This is a routing invariant, not a second proof owner.
function assertHistoryCheckout(workflow){
  const start=workflow.indexOf('      - name: Checkout immutable authenticated Provider evidence');
  const end=workflow.indexOf('      - name: Collect trusted GitHub Actions evidence');
  const next=workflow.indexOf('\n      - ',start+1);
  const step=workflow.slice(start,next);
  if(start<0||next<0||end<=next||
     !step.includes("if: inputs.provider_source_run_id != '' || (inputs.stage == 'post-merge' && (inputs.issue_number == 1749 || inputs.issue_number == 2817 || inputs.issue_number == 4342))")||
     !step.includes('ref: metrics')||!step.includes('path: provider-metrics')||
     !step.includes('persist-credentials: false'))
    reject('post-merge #4342 must have read-only Metrics checkout before collector');
}
function selfTest(){
  const workflow=fs.readFileSync('.github/workflows/agent-sc-acceptance.yml','utf8');
  assertHistoryCheckout(workflow);
  assert.throws(()=>assertHistoryCheckout(workflow.replace(' || inputs.issue_number == 4342','')),
    /read-only Metrics checkout before collector/);
  assert.throws(()=>assertHistoryCheckout(workflow.replace('path: provider-metrics','path: wrong-metrics')),
    /read-only Metrics checkout before collector/);
  const source=[...sources.values()].find(s=>s.file==='agent-issue-audit.yml');
  assert.ok(source);
  const target='a'.repeat(40);
  const original={id:321,run_attempt:1,head_sha:target,
    path:'.github/workflows/'+source.file,
    name:'Issue Audit #4342',repository:{full_name:REPO},
    head_repository:{full_name:REPO},head_branch:'main',
    event:'issues',status:'completed',conclusion:'success',
    created_at:'2026-11-10T00:00:00Z'};
  const writer={...original,id:400,path:'.github/workflows/metrics-agent-telemetry.yml',
    event:'repository_dispatch',actor:{login:'github-actions[bot]'}};
  const jobSteps=['Select missed trusted Agent telemetry source',
    'Validate and append immutable telemetry','Commit metrics history',
    'Verify immutable Git bytes before uploading Run Store receipts',
    'Finalize bounded historical recovery report',
    'Upload scoped historical recovery and expiry inventory']
    .map(name=>({name,conclusion:'success'}));
  const jobs={jobs:[{name:'ingest',run_id:400,run_attempt:1,
    status:'completed',conclusion:'success',id:91,steps:jobSteps}]};
  const artifact={id:11,name:'agent-metrics-history-400-1',
    expired:false,size_in_bytes:120,workflow_run:{id:400}};
  const states=Object.fromEntries(STATUSES.map(s=>[s,0]));
  states.missing_recoverable=1;
  const report={schema_version:1,kind:'agent_metrics_historical_recovery_scope',
    repository:REPO,created_at:'2026-11-23T12:00:00Z',
    start_date:START,end_date:'2026-11-23',
    source_workflow_key:source.key,telemetry_group_id:source.id,
    workflow_path:'.github/workflows/'+source.file,
    page:1,total_pages:2,page_offset:0,probe_limit:12,
    total_runs_in_date_window:110,truncated:false,
    observations:[{run_id:321,attempt:1,source_sha:target,
      status:'missing_recoverable',published:1,recorded:0}],
    counts:states,selected:{run_id:321,run_attempt:1,target_sha:target,
      source_path:original.path,published:1,recorded:0},
    selected_persisted:true,recovered_count:1};
  const originalArtifacts={total_count:1,artifacts:[{
    name:'agent-telemetry-issue-audit-qwen-4342-321-1',
    expired:false,size_in_bytes:100}]};
  const args={writer,jobs,artifact,report,original,originalArtifacts,
    storedCounts:new Map([[source.id+'/321/1',1]]),
    targetSha:target,ancestry:{writer:true,original:true}};
  assert.equal(hasRecoveredHistoricalSelection(report),true);
  assert.equal(hasRecoveredHistoricalSelection({...report,selected:null,
    selected_persisted:false,recovered_count:0}),false);
  assert.equal(hasRecoveredHistoricalSelection({...report,selected_persisted:false,
    recovered_count:0}),false);
  assert.throws(()=>hasRecoveredHistoricalSelection({...report,repository:'foreign/fork'}),
    /unexpected historical report envelope/);
  const proof=attest4342History(args);
  assert.equal(proof.status,'authenticated');
  const context={issue:{number:4342},stage:'post-merge',target_ref:target,
    ci_evidence:{verified_4342_historical_metrics:proof}};
  const pending={criteria:[{criterion:'SC-05',result:'Pending',evidence:[]}]};
  assert.equal(verified4342HistoryCriterion(context,pending).criteria[0].result,'Pass');
  assert.equal(verified4342HistoryCriterion({...context,ci_evidence:null},pending)
    .criteria[0].result,'Pending');
  assert.equal(verified4342HistoryCriterion({...context,ci_evidence:null},{
    criteria:[{criterion:'SC-05',result:'Pass',evidence:[{type:'untrusted',value:'green CI'}]}]})
    .criteria[0].result,'Pending','unsupported Pass must project to Pending');
  assert.deepEqual(verified4342HistoryCriterion({...context,ci_evidence:null},{
    criteria:[{criterion:'SC-05',result:'Pass',evidence:[{type:'untrusted',value:'green CI'}]}]})
    .criteria[0].evidence,[],'unsupported static evidence cannot survive');
  assert.equal(verified4342HistoryCriterion({...context,ci_evidence:null},{
    criteria:[{criterion:'SC-05',result:'Fail'}]}).criteria[0].result,'Fail');
  assert.throws(()=>attest4342History({...args,original:{...original,
    repository:{full_name:'attacker/fork'}}}),/provenance/);
  assert.throws(()=>attest4342History({...args,report:{...report,
    selected_persisted:false}}),/selected and durably persisted/);
  assert.throws(()=>attest4342History({...args,report:{...report,
    counts:{...states,missing_recoverable:0}}}),/status totals/);
  assert.throws(()=>attest4342History({...args,storedCounts:new Map()}),
    /immutable Metrics Store/);
  assert.throws(()=>attest4342History({...args,writer:{...writer,
    actor:{login:'attacker'}}}),/untrusted main-owned/);
  assert.throws(()=>attest4342History({...args,artifact:{
    ...artifact,expired:true}}),/unexpired historical report Artifact/);
  assert.throws(()=>attest4342History({...args,report:{
    ...report,source_workflow_key:'attacker-workflow'}}),/canonical Catalog/);
  assert.throws(()=>attest4342History({...args,report:{
    ...report,truncated:'unknown'}}),/bounded history scope/);
  assert.throws(()=>attest4342History({...args,report:{
    ...report,selected:{...report.selected,target_sha:'b'.repeat(40)}}}),
    /selected run not identified/);
  assert.throws(()=>attest4342History({...args,ancestry:{
    writer:true,original:false}}),/accepted target/);

  console.log('4342 bounded historical Agent Artifact, immutable Store, and fail-closed SC-05 fixtures passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='collect'&&process.argv[3]&&process.argv[4])
    collect(process.argv[3],process.argv[4]);
  else reject('usage: self-test | collect CI_EVIDENCE_JSON TARGET_SHA');
}
