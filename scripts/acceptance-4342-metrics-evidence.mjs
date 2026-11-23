#!/usr/bin/env node
// #4342 SC-04: independent, source-bound post-merge Audit telemetry readback.
// This is a READ-ONLY Acceptance evidence collector, never a Metrics writer.
// Pinned Run IDs are lookup hints; all provenance is re-fetched and validated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildAgentWorkflowTelemetry,validateAgentWorkflowTelemetry,telemetryStoragePath}
  from './agent-workflow-telemetry.mjs';

const REPO='BestNathan/nession';
const SHA=/^[a-f0-9]{40}$/;
export const PROOF=Object.freeze({
  issue:4342,
  source_run_id:45168100944,
  writer_run_id:45168427873,
  target_sha:'bc654241787cdf28ca854cbecd683fa5942101f6',
  group:'issue-audit',
  workflow_path:'.github/workflows/agent-issue-audit.yml',
  raw_path:'raw/workflows/issue-audit/2026-11-23/45168100944-1-issue-4342.json',
  writer_path:'.github/workflows/metrics-agent-telemetry.yml',
});
function reject(why){throw Error('4342 trusted Metrics readback: '+why);}
function positive(v){return Number.isSafeInteger(v)&&v>0;}
function sourceRun(run,path,event){
  return run?.repository?.full_name===REPO&&run?.head_repository?.full_name===REPO&&
    run?.path===path&&run?.event===event&&run?.head_branch==='main'&&
    run?.head_sha===PROOF.target_sha&&run?.status==='completed'&&
    run?.conclusion==='success'&&positive(run.run_attempt)&&
    positive(run.id)&&SHA.test(run.head_sha);
}
function receiptFromLog(log) {
  if(typeof log!=='string'||Buffer.byteLength(log)>8*1024*1024)
    reject('missing/oversized trusted ingest log');
  const receipts=[];
  for(const line of log.split(/\r?\n/)) {
    const m=line.match(/^20\d\d-\d\d-\d\dT\S+Z\s+(\{.*\})\s*$/);
    if(!m||!m[1].includes('"kind":"run_store_receipt_readback"'))continue;
    let value;
    try{value=JSON.parse(m[1]);}catch{reject('invalid readback receipt JSON');}
    receipts.push(value);
  }
  if(receipts.length!==1)reject('missing/duplicate trusted readback receipt');
  return receipts[0];
}
function artifactFound(list,run,name){
  if(!Array.isArray(list?.artifacts)||list.artifacts.length>100||
      !Number.isSafeInteger(list.total_count)||list.total_count!==list.artifacts.length)
    reject('incomplete GitHub artifact listing');
  const found=list.artifacts.filter(x=>x.name===name&&x.workflow_run?.id!==0);
  if(found.length!==1||!positive(found[0].id)||found[0].expired!==false||
     !positive(found[0].size_in_bytes))
    reject('missing/expired/invalid '+name+' artifact');
  return found[0].id;
}
export function attest4342AuditMetrics({source,writer,sourceArtifacts,writerArtifacts,
  writerJobs,writerLog,rawRecord,aggregate}) {
  if(!sourceRun(source,PROOF.workflow_path,'issues')||
     source.id!==PROOF.source_run_id||source.run_attempt!==1)
    reject('untrusted dynamic-name Issue Audit source');
  // Human display names are presentation only. Provenance uses REST path.
  if(!sourceRun(writer,PROOF.writer_path,'workflow_run')||
     writer.id!==PROOF.writer_run_id||writer.run_attempt!==1)
    reject('untrusted main-owned Metrics writer');
  const sourceArtifactId=artifactFound(sourceArtifacts,source,
    'agent-telemetry-issue-audit-qwen-4342-45168100944-1');
  const writerArtifactId=artifactFound(writerArtifacts,writer,
    'run-store-receipt-45168427873-1-agent');
  if(!Array.isArray(writerJobs?.jobs)||writerJobs.jobs.length>100)
    reject('unbounded writer jobs');
  const matching=writerJobs.jobs.filter(j=>j.name==='ingest');
  if(matching.length!==1||matching[0].run_id!==writer.id||
     matching[0].run_attempt!==writer.run_attempt||
     matching[0].status!=='completed'||matching[0].conclusion!=='success')
    reject('unverified ingest job/attempt');
  const required=[
    'Verify telemetry tooling','Resolve source run',
    'Download Agent telemetry artifacts','Validate and append immutable telemetry',
    'Commit metrics history','Verify immutable Git bytes before uploading Run Store receipts',
  ];
  for(const name of required){
    const hits=(matching[0].steps??[]).filter(s=>s.name===name&&s.conclusion==='success');
    if(hits.length!==1)reject('unverified writer step: '+name);
  }
  if(!writerLog.includes('SOURCE_RUN_ID: '+PROOF.source_run_id)||
     !writerLog.includes('EXPECTED_WORKFLOW_ID: '+PROOF.group))
    reject('trusted log source/group environment mismatch');
  const receipt=receiptFromLog(writerLog);
  if(receipt.schema_version!==1||receipt.kind!=='run_store_receipt_readback'||
     receipt.store!=='metrics'||!SHA.test(receipt.commit_sha??'')||
     receipt.ingester_run_id!==String(writer.id)||
     receipt.source_run_id!==String(source.id)||
     !positive(receipt.checked_records)||!positive(receipt.changed_records)||
     receipt.checked_records<receipt.changed_records)
    reject('untrusted source-bound immutable Metrics receipt');
  validateAgentWorkflowTelemetry(rawRecord);
  const id=rawRecord.identity;
  if(rawRecord.kind!=='agent_workflow_run'||id.workflow_id!==PROOF.group||
     id.github_run_id!==source.id||id.github_run_attempt!==source.run_attempt||
     id.repository!==REPO||id.event!==source.event||
     telemetryStoragePath(rawRecord)!==PROOF.raw_path||
     rawRecord.task?.issue!==PROOF.issue||
     rawRecord.agent?.id!=='audit-qwen-01'||
     rawRecord.agent?.role!=='auditor'||rawRecord.agent?.status!=='finished')
    reject('stored raw telemetry source/attempt/task mismatch');
  if(aggregate?.kind!=='agent_metrics_aggregate'||aggregate.schema_version!==1||
     !Number.isFinite(Date.parse(aggregate.generated_at))||
     !(aggregate.windows?.all_time?.runs?.by_workflow?.['issue-audit']>=1))
    reject('missing independently published aggregate');
  return Object.freeze({
    kind:'verified_4342_audit_metrics_readback',status:'authenticated',
    source_sha:PROOF.target_sha,source_run_id:source.id,source_attempt:source.run_attempt,
    source_workflow_key:'agent-issue-audit',telemetry_group_id:PROOF.group,
    source_artifact_id:sourceArtifactId,writer_run_id:writer.id,
    writer_attempt:writer.run_attempt,writer_job_id:matching[0].id,
    writer_artifact_id:writerArtifactId,metrics_commit_sha:receipt.commit_sha,
    raw_path:PROOF.raw_path,agent_id:rawRecord.agent.id,agent_role:rawRecord.agent.role,
    aggregate_generated_at:aggregate.generated_at,
    aggregate_issue_audit_all_time:aggregate.windows.all_time.runs.by_workflow['issue-audit'],
    aggregate_issue_audit_7d:aggregate.windows?.['7d']?.runs?.by_workflow?.['issue-audit']??null,
    observed_run_name:source.name, // human display only, never an admission key
    attestation:'GitHub REST source + attempt-scoped Artifact + writer jobs/steps + trusted log receipt + exact immutable Git object + aggregate',
  });
}
export function verified4342AuditCriterion(context,normalized) {
  if(Number(context?.issue?.number)!==PROOF.issue||context.stage!=='post-merge')
    return normalized;
  const item=normalized.criteria?.find(i=>i.criterion==='SC-04');
  if(!item)return normalized;
  const proof=context.ci_evidence?.verified_4342_audit_metrics;
  const verified=proof?.kind==='verified_4342_audit_metrics_readback'&&
    proof.status==='authenticated'&&proof.target_sha===context.target_ref&&
    proof.source_sha===PROOF.target_sha&&
    proof.source_run_id===PROOF.source_run_id&&proof.source_attempt===1&&
    proof.writer_run_id===PROOF.writer_run_id&&
    proof.telemetry_group_id===PROOF.group&&
    proof.raw_path===PROOF.raw_path&&
    SHA.test(proof.metrics_commit_sha??'')&&positive(proof.source_artifact_id)&&
    positive(proof.writer_artifact_id)&&positive(proof.writer_job_id);
  if(!verified){
    if(item.result==='Pass')reject('SC-04 Pass without authentic post-merge Audit readback');
    return normalized;
  }
  if(item.result==='Fail'||item.result==='N/A')return normalized;
  return {...normalized,criteria:normalized.criteria.map(entry=>
    entry.criterion!=='SC-04'?entry:{
      ...entry,result:'Pass',
      evidence:[{type:'authenticated-telemetry',
        value:'source '+proof.source_run_id+'/'+proof.source_attempt+
          ', artifact '+proof.source_artifact_id+', writer '+proof.writer_run_id+
          ', receipt '+proof.writer_artifact_id+', immutable metrics '+proof.metrics_commit_sha+
          ', '+proof.raw_path}],
      summary:'GitHub-authenticated dynamic-name Audit execution was persisted immutably and independently read back with writer receipt and aggregate',
    })};
}
export function ghApiArgs4342(endpoint,format='json'){
  if(!/^actions\/(runs|jobs)\/[0-9]+(?:\/.*)?$/.test(endpoint) &&
     !/^contents\/[a-z0-9./_-]+\?ref=[a-f0-9]{40}$/.test(endpoint) &&
     endpoint!=='git/ref/heads/metrics')
    reject('untrusted GitHub endpoint');
  // `gh api` (2026-11) refuses raw logs containing ANSI escape sequences
  // unless explicitly opted in; this is safe only for READ-ONLY text logs.
  // JSON provenance and immutable Store reads keep strict default decoding.
  const args=['api'];
  if(format==='text' && /^actions\/jobs\/[0-9]+\/logs$/.test(endpoint))
    args.push('--allow-escape-sequences');
  else if(format!=='json')
    reject('raw text access restricted to trusted job logs');
  return [...args,'repos/'+REPO+'/'+endpoint];
}
function gh(endpoint,format='json'){
  const args=ghApiArgs4342(endpoint,format);
  const data=execFileSync('gh',args,{encoding:'utf8',timeout:30000,
    maxBuffer:9*1024*1024,stdio:['ignore','pipe','pipe']});
  return format==='text'?data:JSON.parse(data);
}
function githubContents(rawPath,commit){
  if(!SHA.test(commit))reject('untrusted immutable commit SHA');
  const entry=gh('contents/'+rawPath+'?ref='+commit);
  if(entry?.path!==rawPath||entry?.type!=='file'||
     entry?.encoding!=='base64'||typeof entry.content!=='string')
    reject('missing GitHub immutable content blob');
  const bytes=Buffer.from(entry.content.replace(/\s/g,''),'base64');
  if(!bytes.length||bytes.length>2*1024*1024)reject('invalid raw Git content');
  return JSON.parse(bytes.toString('utf8'));
}
function collect(file,targetSha) {
  if(process.env.GITHUB_REPOSITORY!==REPO||
     process.env.ACCEPTANCE_STAGE!=='post-merge'||
     String(process.env.ISSUE_NUMBER)!==String(PROOF.issue)||
     !SHA.test(targetSha))
    reject('not the approved #4342 post-merge target');
  // Source Audit ran on the original merged fix. Later main commits may
  // independently judge those immutable bytes only if the exact source fix
  // is an ancestor of the authenticated target checkout.
  const workspace=path.join(process.env.GITHUB_WORKSPACE??'', 'workspace');
  if(!path.isAbsolute(workspace)||!fs.existsSync(workspace))
    reject('trusted target checkout unavailable');
  try {
    const actual=execFileSync('git',['-C',workspace,'rev-parse','HEAD'],
      {encoding:'utf8',timeout:20000}).trim();
    if(actual!==targetSha)reject('target checkout differs from accepted SHA');
    execFileSync('git',['-C',workspace,'merge-base','--is-ancestor',PROOF.target_sha,targetSha],
      {stdio:'ignore',timeout:20000});
  }catch {
    reject('Audit fix is not a verified ancestor of accepted main target');
  }
  const evidence=JSON.parse(fs.readFileSync(file,'utf8'));
  if(evidence?.kind!=='acceptance_ci_evidence'||evidence.target_sha!==targetSha)
    reject('untrusted Acceptance evidence file/target');
  const source=gh('actions/runs/'+PROOF.source_run_id);
  const writer=gh('actions/runs/'+PROOF.writer_run_id);
  const sourceArtifacts=gh('actions/runs/'+source.id+'/artifacts?per_page=100');
  const writerArtifacts=gh('actions/runs/'+writer.id+'/artifacts?per_page=100');
  const writerJobs=gh('actions/runs/'+writer.id+'/attempts/'+writer.run_attempt+'/jobs?per_page=100');
  const ingest=writerJobs.jobs?.filter(job=>job.name==='ingest')??[];
  if(ingest.length!==1||!positive(ingest[0].id))reject('writer ingest job unavailable');
  const writerLog=gh('actions/jobs/'+ingest[0].id+'/logs','text');
  const receipt=receiptFromLog(writerLog);
  const rawRecord=githubContents(PROOF.raw_path,receipt.commit_sha);
  const aggregate=githubContents('agent-metrics.json',
    String(gh('git/ref/heads/metrics')?.object?.sha??''));
  const proof=attest4342AuditMetrics({
    source,writer,sourceArtifacts,writerJobs,writerLog,writerArtifacts,rawRecord,aggregate,
  });
  // Source SHA is separately pinned; bind this readback to the exact selected
  // descendant main SHA without modifying the historical Source identity.
  const targetBoundProof={...proof,target_sha:targetSha};
  fs.writeFileSync(file,JSON.stringify({
    ...evidence,verified_4342_audit_metrics:targetBoundProof,
  },null,2)+'\n');
  console.log('verified #4342 real Audit telemetry: source '+proof.source_run_id+
    ', writer '+proof.writer_run_id+', metrics '+proof.metrics_commit_sha);
}
function selfTest(){
  assert.deepEqual(ghApiArgs4342('actions/jobs/137671336114/logs','text'),[
    'api','--allow-escape-sequences',
    'repos/'+REPO+'/actions/jobs/137671336114/logs',
  ]);
  assert.deepEqual(ghApiArgs4342('actions/runs/'+PROOF.source_run_id),[
    'api','repos/'+REPO+'/actions/runs/'+PROOF.source_run_id,
  ]);
  for(const [endpoint,format] of [
    ['actions/jobs/137671336114/logs','raw'],
    ['actions/runs/'+PROOF.source_run_id,'text'],
    ['actions/jobs/137671336114/logs?ref=main','text'],
    ['../attacker','json'],
  ])assert.throws(()=>ghApiArgs4342(endpoint,format),/untrusted|restricted/);
  const raw=buildAgentWorkflowTelemetry({
    workflow_id:'issue-audit',github_run_id:PROOF.source_run_id,github_run_attempt:1,
    github_workflow:'Agent / Issue Audit',repository:REPO,event:'issues',
    task:{id:'issue-4342',type:'issue-audit',issue:4342},
    agent:{provider:'claude-code',id:'audit-qwen-01',role:'auditor',status:'finished'},
    timing:{started_at:'2026-11-23T11:47:15.172Z'},
    result:{status:'repaired'},
  });
  const mkRun=(id,path,event,name)=>({id,run_attempt:1,
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    head_branch:'main',head_sha:PROOF.target_sha,path,event,name,
    status:'completed',conclusion:'success'});
  const source=mkRun(PROOF.source_run_id,PROOF.workflow_path,'issues','Issue Audit #4342');
  const writer=mkRun(PROOF.writer_run_id,PROOF.writer_path,'workflow_run',
    'Metrics / Agent Telemetry Ingest');
  const artifact=(id,name)=>({id,name,expired:false,size_in_bytes:234,
    workflow_run:{id:PROOF.source_run_id}});
  const sourceArtifacts={total_count:1,artifacts:[artifact(11,
    'agent-telemetry-issue-audit-qwen-4342-45168100944-1')]};
  const writerArtifacts={total_count:1,artifacts:[artifact(22,
    'run-store-receipt-45168427873-1-agent')]};
  const steps=[
    'Verify telemetry tooling','Resolve source run','Download Agent telemetry artifacts',
    'Validate and append immutable telemetry','Commit metrics history',
    'Verify immutable Git bytes before uploading Run Store receipts',
  ].map(name=>({name,conclusion:'success'}));
  const writerJobs={jobs:[{id:33,run_id:writer.id,run_attempt:1,name:'ingest',
    status:'completed',conclusion:'success',steps}]};
  const log='2026-11-23T11:48:30Z SOURCE_RUN_ID: 45168100944\n'+
    '2026-11-23T11:48:30Z EXPECTED_WORKFLOW_ID: issue-audit\n'+
    '2026-11-23T11:48:59Z '+JSON.stringify({schema_version:1,
      kind:'run_store_receipt_readback',store:'metrics',
      commit_sha:'a'.repeat(40),ingester_run_id:String(writer.id),
      source_run_id:String(source.id),checked_records:4,changed_records:4});
  const aggregate={schema_version:1,kind:'agent_metrics_aggregate',
    generated_at:'2026-11-23T11:49:00.000Z',
    windows:{all_time:{runs:{by_workflow:{'issue-audit':1}}},
      '7d':{runs:{by_workflow:{'issue-audit':1}}}}};
  const args={source,writer,sourceArtifacts,writerArtifacts,writerJobs,
    writerLog:log,rawRecord:raw,aggregate};
  const proof=attest4342AuditMetrics(args);
  assert.equal(proof.status,'authenticated');
  const context={issue:{number:4342},stage:'post-merge',target_ref:PROOF.target_sha,
    ci_evidence:{verified_4342_audit_metrics:{...proof,target_sha:PROOF.target_sha}}};
  const result={criteria:[{criterion:'SC-04',result:'Pending',evidence:[]}]};
  assert.equal(verified4342AuditCriterion(context,result).criteria[0].result,'Pass');
  const descendant='d'.repeat(40);
  assert.equal(verified4342AuditCriterion({...context,target_ref:descendant,
    ci_evidence:{verified_4342_audit_metrics:{...proof,target_sha:descendant}}},result)
    .criteria[0].result,'Pass');
  assert.equal(verified4342AuditCriterion({...context,target_ref:descendant},result)
    .criteria[0].result,'Pending','stale exact-target proof cannot authorize later SHA');
  assert.throws(()=>attest4342AuditMetrics({...args,source:{...source,
    repository:{full_name:'attacker/nession'}}}),/untrusted/);
  assert.throws(()=>attest4342AuditMetrics({...args,source:{...source,
    path:'.github/workflows/evil.yml'}}),/untrusted/);
  assert.throws(()=>attest4342AuditMetrics({...args,source:{...source,
    name:'Any presentation name',head_sha:'b'.repeat(40)}}),/untrusted/);
  assert.equal(attest4342AuditMetrics({...args,source:{...source,
    name:'Any dynamic human display name'}}).status,'authenticated');
  assert.throws(()=>attest4342AuditMetrics({...args,rawRecord:{...raw,
    identity:{...raw.identity,github_run_attempt:2}}}),/mismatch/);
  assert.throws(()=>attest4342AuditMetrics({...args,writerLog:log+'\n'+log}),
    /duplicate trusted readback receipt/);
  assert.throws(()=>verified4342AuditCriterion({...context,ci_evidence:null},{
    criteria:[{criterion:'SC-04',result:'Pass'}]}),/Pass without authentic/);
  assert.equal(verified4342AuditCriterion({...context,ci_evidence:null},result)
    .criteria[0].result,'Pending');
  console.log('4342 authenticated Metrics source, writer, receipt, immutable raw and fail-closed acceptance fixtures passed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='self-test')selfTest();
  else if(process.argv[2]==='collect'&&process.argv[3]&&process.argv[4])
    collect(process.argv[3],process.argv[4]);
  else reject('usage: self-test | collect CI_EVIDENCE_JSON TARGET_SHA');
}
