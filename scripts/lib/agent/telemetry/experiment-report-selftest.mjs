import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildAgentWorkflowTelemetry,telemetryStoragePath} from '../../../agent-workflow-telemetry.mjs';
import {buildExecutionTrace,traceStoragePath,normalizeNativeTrace} from './execution-trace.mjs';
import {buildExperimentReport,generatePinnedReport,renderExperimentMarkdown} from './experiment-report.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-agent-experiment-'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const SOURCE='a'.repeat(40),OTHER='b'.repeat(40);
function makeRun({runId,attempt=1,issue=1737,shaValue=SOURCE,
  agentId='dev-qwen-01',provider='claude-code',model='qwen3.7-plus',
  toolsObserved=true,tokenTotal=21,usd=null}){
  return buildAgentWorkflowTelemetry({
    workflow_id:'agent-develop',github_run_id:runId,github_run_attempt:attempt,
    repository:'BestNathan/nession',event:'workflow_dispatch',
    unique_run_name:runId+'-'+attempt+'-issue-'+issue+'-'+agentId,
    task:{id:'issue-'+issue+'-develop',type:'implement',issue,target_ref:shaValue},
    agent:{id:agentId,role:'developer',provider,
      model:{id:model},harness_sha256:'f'.repeat(64),status:'finished'},
    execution:{tools_observed:toolsObserved,tool_calls:toolsObserved?['Read']:undefined},
    tokens:{total:tokenTotal,input:tokenTotal==null?null:tokenTotal-1,
      output:tokenTotal==null?null:1},
    cost:{charged_usd:usd},
    timing:{started_at:'2026-10-14T01:00:00.000Z',
      finished_at:'2026-10-14T01:00:10.000Z',agent_duration_ms:10000},
    result:{status:'finished'},
  });
}
const qwen=makeRun({runId:100,usd:0.1}),cursor=makeRun({runId:101,
  agentId:'dev-cursor-01',provider:'cursor',model:'composer',tokenTotal:null,toolsObserved:false});
const obs=normalizeNativeTrace('claude-code',[
  {type:'assistant',message:{content:[{type:'tool_use',id:'read1',name:'Read'}]}},
  {type:'user',message:{content:[{type:'tool_result',tool_use_id:'read1',is_error:false}]}}
],qwen,{model:'unobserved',tools:'observed',skills:'unobserved',mcp:'unobserved'});
const empty=buildExecutionTrace(cursor,[],{model:'unobserved',tools:'unobserved',
  skills:'unobserved',mcp:'unobserved'});
const proof={schema_version:1,kind:'trusted_agent_evidence_snapshot',
  repository:'BestNathan/nession',
  reviews:[{issue:1737,pr:50,agent_id:'dev-qwen-01',sha:SOURCE,
    outcome:'changes_requested',run_id:100,attempt:1,ordinal:1},
    {issue:1737,pr:50,agent_id:'dev-qwen-01',sha:SOURCE,
      outcome:'approved',run_id:100,attempt:1,ordinal:2}],
  acceptances:[{issue:1737,sc:'SC-01',sha:SOURCE,outcome:'Pass',run_id:100,attempt:1}],
  checkpoints:[{issue:1737,agent_id:'dev-qwen-01',sha:SOURCE,
    recovered:true,run_id:100,attempt:1}]};
try{
  const report=buildExperimentReport([qwen,cursor],[obs,empty],proof,{
    metrics_commit_sha:OTHER,evidence_sha256:'c'.repeat(64)});
  assert.equal(report.groups.length,2);
  const qw=report.groups.find(x=>x.group.includes('qwen3.7-plus'));
  const cs=report.groups.find(x=>x.group.includes('composer'));
  assert.equal(qw.tool_calls_total,1);
  assert.equal(qw.skill_invocations_total,null);
  assert.equal(qw.tokens_total,21);
  assert.equal(qw.usd_total,0.1);
  assert.equal(cs.tokens_total,null);
  assert.equal(cs.tool_calls_total,null);
  assert.equal(report.review.first_pass_rate,0);
  assert.equal(report.review.repair_requests,1);
  assert.equal(report.acceptance.accepted_sc_count,1);
  assert.equal(report.acceptance.accepted_tokens_total,21);
  assert.equal(report.acceptance.accepted_usd_total,0.1);
  assert.equal(report.recovery.rate,1);
  const estimatedRun=makeRun({runId:102,usd:null});
  estimatedRun.cost.estimated_usd=0.3;
  const mixed=buildExperimentReport([qwen,estimatedRun],[]);
  assert.equal(mixed.issues[0].usd_total,null);
  assert.equal(mixed.issues[0].cost_basis,'mixed_or_incomplete');
  assert.equal(mixed.issues[0].usd_coverage.observed,2);
  assert.equal(mixed.issues[0].usd_coverage.total,2);
  const est=buildExperimentReport([estimatedRun],[]);
  assert.equal(est.issues[0].cost_basis,'estimated');
  assert.equal(est.issues[0].usd_total,0.3);
  assert.equal(report.inputs.trace_count,2);
  assert.ok(!JSON.stringify(report).includes('model prompt'));
  assert.ok(renderExperimentMarkdown(report).includes('unobserved'));
  assert.deepEqual(buildExperimentReport([cursor,qwen],[empty,obs],proof,{
    metrics_commit_sha:OTHER,evidence_sha256:'c'.repeat(64)}),report);
  const missing=buildExperimentReport([qwen,cursor],[obs,empty]);
  assert.equal(missing.review.first_pass_rate,null);
  assert.equal(missing.review.repair_requests,null);
  assert.equal(missing.recovery.rate,null);
  assert.equal(missing.acceptance.accepted_tokens_total,null);
  assert.equal(missing.groups.find(x=>x.group.includes('qwen3.7-plus')).mcp_calls_total,null);
  assert.throws(()=>buildExperimentReport([qwen,qwen],[obs]),/duplicate run/);
  assert.throws(()=>buildExperimentReport([qwen,cursor],[obs,obs]),/duplicate trace/);
  assert.throws(()=>buildExperimentReport([cursor],[obs]),/orphan trace/);
  assert.throws(()=>buildExperimentReport([qwen],[{...obs,task:{...obs.task,issue:1740}}]),/trace|invalid/);
  assert.throws(()=>buildExperimentReport([qwen],[obs],{
    ...proof,acceptances:[{...proof.acceptances[0],sha:OTHER}]}),/unmatched exact-SHA/);
  assert.throws(()=>buildExperimentReport([qwen],[obs],{
    ...proof,reviews:[proof.reviews[0],proof.reviews[0]]}),/duplicate\/conflicting/);
  assert.throws(()=>buildExperimentReport([qwen],[obs],{
    ...proof,reviews:[{...proof.reviews[0],outcome:'approved',ordinal:2}]}),/missing first review/);
  assert.throws(()=>buildExperimentReport([qwen],[obs],{
    ...proof,acceptances:[{...proof.acceptances[0],outcome:'Pass',sc:'SC-XX'}]}),/invalid SC proof/);
  const metrics=path.join(root,'metrics');fs.mkdirSync(metrics);
  const runPath=path.join(metrics,telemetryStoragePath(qwen));
  const tracePath=path.join(metrics,traceStoragePath(obs));
  fs.mkdirSync(path.dirname(runPath),{recursive:true});
  fs.mkdirSync(path.dirname(tracePath),{recursive:true});
  fs.writeFileSync(runPath,JSON.stringify(qwen,null,2)+'\n');
  fs.writeFileSync(tracePath,JSON.stringify(obs,null,2)+'\n');
  const git=(...args)=>execFileSync('git',['-C',metrics,...args],{encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Agent Metrics Fixture');
  git('config','user.email','agent-fixture@example.invalid');
  git('add','-A');git('commit','-qm','pinned fixture');
  const pinned=git('rev-parse','HEAD');
  const evidenceFile=path.join(root,'evidence.json');
  fs.writeFileSync(evidenceFile,JSON.stringify(proof)+'\n');
  const digest=sha(fs.readFileSync(evidenceFile));
  const result=generatePinnedReport(metrics,pinned,evidenceFile,digest);
  assert.equal(result.report.groups.length,1);
  assert.equal(result.manifest.files.length,2);
  assert.equal(result.report.evidence_sha256,digest);
  assert.ok(result.manifest.files.every(x=>x.sha256.length===64));
  assert.throws(()=>generatePinnedReport(metrics,OTHER,evidenceFile,digest),/SHA mismatch/);
  assert.throws(()=>generatePinnedReport(metrics,pinned,evidenceFile,'f'.repeat(64)),/digest mismatch/);
  const outside=path.join(root,'unsafe.txt');fs.writeFileSync(outside,'PRIVATE');
  const evil=path.join(metrics,'raw/events/evil.json');
  fs.symlinkSync(outside,evil);
  assert.throws(()=>generatePinnedReport(metrics,pinned,evidenceFile,digest),/dirty|symlink/);
  fs.unlinkSync(evil);
  fs.writeFileSync(runPath,JSON.stringify({...qwen,agent:{...qwen.agent,id:'other'}}));
  assert.throws(()=>generatePinnedReport(metrics,pinned,evidenceFile,digest),/dirty|storage path mismatch|canonical|trace/);
  console.log('Agent experiment report: exact-SHA lineage, Qwen/Cursor coverage, Review/SC joins, replay and tamper fixtures passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
