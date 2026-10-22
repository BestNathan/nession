#!/usr/bin/env node
// Deterministic failed-pending-slot and competing-writer regression. Entirely
// disposable local Git repositories; never accesses production refs or secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chooseMissing} from './agent-telemetry-reconcile.mjs';
import {stageAgentMetrics} from './agent-telemetry-ingest.mjs';
import {buildAgentWorkflowTelemetry,telemetryStoragePath} from './agent-workflow-telemetry.mjs';
import {auditAnchoredRunStore} from './run-store-integrity.mjs';

const REPO='BestNathan/nession';
function git(root,...args){
  return execFileSync('git',['-C',root,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},
  }).trim();
}
function mkdir(root,sub){const p=path.join(root,sub);fs.mkdirSync(p,{recursive:true});return p;}
// GitHub Actions' concurrency group is not a durable queue: one running +
// one pending; a newer pending workflow replaces the older pending workflow.
export function simulatePendingReplacement(events){
  if(!Array.isArray(events)||events.length<1)throw Error('missing queue events');
  const running=events[0],cancelled=[];let pending=null;
  for(const event of events.slice(1)){
    if(pending!==null)cancelled.push(pending);
    pending=event;
  }
  return {running,pending,cancelled};
}
function makeRun(runId){
  return buildAgentWorkflowTelemetry({
    workflow_id:'agent-provider-smoke',github_workflow:'Agent / Provider Smoke',
    github_run_id:runId,github_run_attempt:1,repository:REPO,event:'push',
    unique_run_name:runId+'-1-issue-1664-replay-fixture',
    task:{id:'issue-1664-replay-fixture',type:'acceptance',issue:1664,
      target_ref:'a'.repeat(40)},
    agent:{provider:'claude-code',id:'dev-qwen-01',role:'developer'},
    timing:{started_at:'2026-10-14T00:00:00Z',
      finished_at:'2026-10-14T00:01:00Z'},
  });
}
function incoming(root,id){
  const dir=mkdir(root,'incoming-'+id),record=makeRun(id);
  fs.writeFileSync(path.join(dir,'agent-telemetry.json'),
    JSON.stringify(record,null,2)+'\n');
  return {dir,record,trust:{run_id:id,attempt:1,
    workflow_id:'agent-provider-smoke',repository:REPO}};
}
async function selfTest(){
  const queue=simulatePendingReplacement(['scheduled-repository-metrics',
    'ingest-for-321','ingest-for-322']);
  assert.deepEqual(queue,{running:'scheduled-repository-metrics',
    pending:'ingest-for-322',cancelled:['ingest-for-321']});
  const source={id:321,run_attempt:1,head_sha:'a'.repeat(40),event:'push',
    head_branch:'main',path:'.github/workflows/agent-provider-smoke.yml',
    name:'Agent / Provider Smoke',status:'completed',conclusion:'success',
    repository:{full_name:REPO},head_repository:{full_name:REPO},
    created_at:'2026-10-14T00:00:00Z'};
  // Run 321 was successfully produced, although its downstream ingest job
  // was cancelled before start. GitHub's source API remains recoverable.
  const sourceList=new Map([['agent-provider-smoke.yml',[source]]]);
  assert.equal((await chooseMissing(sourceList,new Map(),async()=>1)).run_id,321);
  assert.equal(await chooseMissing(sourceList,new Map([
    ['agent-provider-smoke/321/1',1]]),async()=>1),null);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nession-metrics-race-'));
  try{
    const remote=mkdir(root,'remote.git'),seed=mkdir(root,'seed');
    git(remote,'init','--bare','-q');
    git(seed,'init','-q','-b','metrics');
    git(seed,'config','user.name','Nession Fixture');
    git(seed,'config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(seed,'README.md'),'untrusted migration baseline\n');
    git(seed,'add','README.md');
    git(seed,'commit','-qm','migration baseline');
    const baseline=git(seed,'rev-parse','HEAD');
    git(seed,'remote','add','origin',remote);
    git(seed,'push','-q','origin','HEAD:refs/heads/metrics');
    const writer1=path.join(root,'writer-1'),writer2=path.join(root,'writer-2');
    git(root,'clone','-q','--branch','metrics',remote,writer1);
    git(root,'clone','-q','--branch','metrics',remote,writer2);
    for(const dir of [writer1,writer2]){
      git(dir,'config','user.name','Nession Fixture');
      git(dir,'config','user.email','fixture@example.invalid');
      assert.equal(git(dir,'rev-parse','HEAD'),baseline);
    }
    const a=incoming(root,321),b=incoming(root,322);
    assert.deepEqual(stageAgentMetrics(a.dir,writer1,a.trust),
      {found:1,changed:1});
    assert.deepEqual(stageAgentMetrics(b.dir,writer2,b.trust),
      {found:1,changed:1});
    git(writer1,'add','raw');git(writer1,'commit','-qm','append run 321');
    git(writer2,'add','raw');git(writer2,'commit','-qm','append run 322');
    git(writer1,'push','-q','origin','HEAD:refs/heads/metrics');
    // Legitimate stale writer must not force-push away run 321.
    assert.throws(()=>git(writer2,'push','-q','origin','HEAD:refs/heads/metrics'));
    git(writer2,'fetch','-q','origin','metrics');
    git(writer2,'reset','-q','--hard','FETCH_HEAD');
    // The next scheduled reconciliation replays run 322 from the original
    // immutable artifact, under a fresh Store HEAD; no dropped record.
    assert.deepEqual(stageAgentMetrics(b.dir,writer2,b.trust),
      {found:1,changed:1});
    git(writer2,'add','raw');git(writer2,'commit','-qm','recover run 322');
    git(writer2,'push','-q','origin','HEAD:refs/heads/metrics');
    const audit=path.join(root,'audit');
    git(root,'clone','-q','--branch','metrics',remote,audit);
    const head=git(audit,'rev-parse','HEAD');
    const verified=auditAnchoredRunStore(audit,'metrics',baseline,head);
    assert.equal(verified.checked_commits,2);
    assert.equal(verified.checked_changes,2);
    for(const source of [a,b]){
      const file=path.join(audit,telemetryStoragePath(source.record));
      assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).identity.github_run_id,
        Number(source.trust.run_id));
      assert.deepEqual(stageAgentMetrics(source.dir,audit,source.trust),
        {found:1,changed:0});
    }
    const conflicting=makeRun(322);
    conflicting.result={status:'malicious divergent replay'};
    fs.writeFileSync(path.join(b.dir,'agent-telemetry.json'),
      JSON.stringify(conflicting)+'\n');
    assert.throws(()=>stageAgentMetrics(b.dir,audit,b.trust),
      /immutable metrics collision/);
    assert.throws(()=>stageAgentMetrics(a.dir,audit,{...a.trust,attempt:2}),
      /source workflow/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  console.log('Agent Metrics queue replacement + two stale Git writers: no force push, immutable CAS-style retry, replay and conflict fixtures passed');
}
await selfTest();
