#!/usr/bin/env node
// #1664: Provider failures must remain observable without leaking native
// conversations, tool arguments, failed prompts or unobserved metrics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildCursorFailureTelemetry}
  from './development-worker.mjs';
import {telemetryStoragePath,writeAgentWorkflowTelemetry,
  validateAgentWorkflowTelemetry}
  from '../../../agent-workflow-telemetry.mjs';

const prior=process.env.GITHUB_RUN_ATTEMPT;
process.env.GITHUB_RUN_ATTEMPT='1';
const sha='3d8e3807cc01f6082734b8d0ba458217c28f60a4';
const original={
  authorized:true,role:'developer',task:'repair',issue:1997,
  action_id:'ed14323e0466b23ec739a712ab63bfc16cbbbe225b1118a4cbeab64e419574a5',
  input_sha:sha,run_id:42042826823,agent_id:'dev-cursor-01',
  resume_from:{checkpoint_version:3,
    checkpoint_commit_sha:'eb891ee2154d02ddb758d50f0f694e70a343ffdf'},
};
const secret='NEVER-PERSIST-RAW-NATIVE-ERROR-OR-SECRET';
const base={admission:original,model:'cursor-default',
  started:Date.parse('2026-11-06T00:00:00.000Z'),
  finished:Date.parse('2026-11-06T00:00:02.100Z'),
  category:'provider-outcome-unverified',harnessDigest:'a'.repeat(64)};
try{
  const failed=buildCursorFailureTelemetry({...base,meta:{
    status:'error',resumed:true,turns:0,tool_calls:[],
    error:secret,conversation:secret,usage:null,
    model:{id:'cursor-default'},run_id:null}});
  validateAgentWorkflowTelemetry(failed);
  assert.equal(failed.result.status,'error');
  assert.equal(failed.result.failure_category,'provider-outcome-unverified');
  assert.equal(failed.agent.status,'error');
  assert.equal(failed.agent.provider,'cursor');
  assert.equal(failed.task.restored_checkpoint_version,3);
  assert.equal(failed.identity.github_run_id,42042826823);
  assert.equal(failed.identity.github_run_attempt,1);
  assert.equal(failed.execution.turns,0);
  assert.equal(failed.execution.model_requests,null);
  assert.deepEqual(failed.execution.tools,
    {observed:false,total:null,unique:null,by_name:null});
  assert.equal(failed.tokens.total,null);
  assert.equal(failed.cost.raw_usd,null);
  assert.equal(failed.timing.agent_duration_ms,2100);
  assert.equal(telemetryStoragePath(failed),
    'raw/workflows/agent-develop/2026-11-06/42042826823-1-issue-1997-development.json');
  assert.ok(!JSON.stringify(failed).includes(secret));
  const raised=buildCursorFailureTelemetry({...base,
    category:'provider-call-failed',meta:null});
  assert.equal(raised.execution.turns,null);
  assert.equal(raised.agent.run_id,null);
  assert.equal(raised.execution.tools.observed,false);
  const observed=buildCursorFailureTelemetry({...base,meta:{
    status:'finished',turns:2,resumed:true,
    tool_calls:['read','grep'],usage:{input:12,output:7},
    cost:{raw_usd:0.002},message:secret,agent_id:secret}});
  assert.equal(observed.execution.tools.observed,true);
  assert.equal(observed.execution.tools.total,2);
  assert.equal(observed.execution.tools.by_name.read,1);
  assert.equal(observed.execution.tools.by_name.grep,1);
  assert.equal(observed.tokens.input,12);
  assert.equal(observed.cost.raw_usd,0.002);
  assert.ok(!JSON.stringify(observed).includes(secret));
  for(const change of [
    {category:'raw-error:'+secret},{finished:base.started-1},
    {admission:{...original,issue:2817}},
    {admission:{...original,input_sha:'not-a-sha'}},
  ])assert.throws(()=>buildCursorFailureTelemetry({...base,...change}),
    /invalid sanitized Developer failure telemetry source/);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cursor-failed-telemetry-'));
  try{
    const file=path.join(tmp,'agent-telemetry.json');
    writeAgentWorkflowTelemetry(file,failed);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),failed);
    assert.equal(fs.readdirSync(tmp).length,1);
    assert.ok(!fs.readFileSync(file,'utf8').includes(secret));
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
  const code=fs.readFileSync(
    'scripts/lib/agent/orchestration/development-worker.mjs','utf8');
  assert.match(code,/invokedAt=Date\.now\(\);/);
  assert.match(code,/if\(invokedAt!==null&&!telemetryWritten\)/);
  assert.match(code,/writeAgentWorkflowTelemetry\(path\.join\(out,'agent-telemetry\.json'\),telemetry\)/);
  console.log('Cursor failed Provider telemetry: sanitized canonical Run, no fabricated unobserved counts, secret-negative, success/failure distinction and output verified');
}finally{
  if(prior===undefined)delete process.env.GITHUB_RUN_ATTEMPT;
  else process.env.GITHUB_RUN_ATTEMPT=prior;
}
