#!/usr/bin/env node
// Trusted main-owned writer helper. Source-workflow identity is resolved and
// authenticated by metrics-agent-telemetry.yml BEFORE invoking this code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentWorkflowTelemetry, validateAgentWorkflowTelemetry, telemetryStoragePath } from './agent-workflow-telemetry.mjs';
import { buildExecutionTrace, validateExecutionTrace, validateTraceSource, traceStoragePath } from './lib/agent/telemetry/execution-trace.mjs';

function reject(s) { throw new Error('trusted Agent Metrics ingest: ' + s); }
function walk(dir, files = []) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) reject('symlink in artifact tree');
  if (st.isFile()) {
    if (!dir.endsWith('.json') || st.size > 3 * 1024 * 1024) reject('unsupported/oversized artifact');
    files.push(dir);
  } else if (st.isDirectory()) {
    for (const item of fs.readdirSync(dir).sort()) walk(path.join(dir, item), files);
  } else reject('nonregular artifact path');
  return files;
}
function safePath(root, relative) {
  const rootAbs = path.resolve(root), full = path.resolve(rootAbs, relative);
  if (!full.startsWith(rootAbs + path.sep) || !/^raw\/(workflows|events)\//.test(relative)) reject('unsafe raw destination');
  const parts = path.relative(rootAbs, full).split(path.sep);
  let dir = rootAbs;
  for (const part of parts.slice(0,-1)) {
    dir = path.join(dir,part);
    if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())) reject('nonregular destination directory');
  }
  if (fs.existsSync(full) && (!fs.lstatSync(full).isFile() || fs.lstatSync(full).isSymbolicLink())) reject('nonregular destination file');
  return full;
}
function content(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { reject('invalid JSON artifact: '+path.basename(file)); }
  if (value?.kind === 'agent_workflow_run') return validateAgentWorkflowTelemetry(value);
  if (value?.kind === 'agent_execution_trace') return validateExecutionTrace(value);
  reject('unsupported metrics record kind');
}
function relative(record) {
  return record.kind === 'agent_execution_trace' ? traceStoragePath(record) : telemetryStoragePath(record);
}
function contextOf(record) {
  return record.identity;
}
export function stageAgentMetrics(sourceDir, metricsDir, trust) {
  if (!trust || !/^[0-9]+$/.test(String(trust.run_id)) ||
      !Number.isSafeInteger(Number(trust.run_id)) || Number(trust.run_id) <= 0 ||
      !/^[0-9]+$/.test(String(trust.attempt)) || Number(trust.attempt) <= 0 ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(trust.workflow_id ?? '') ||
      !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trust.repository ?? '')) {
    reject('invalid trusted upstream run context');
  }
  const incoming = walk(sourceDir);
  if (!incoming.length || incoming.length > 200) reject('empty/oversized telemetry artifact set');
  const planned = new Map();
  const records = new Map();
  for (const file of incoming) {
    const record = content(file), id = contextOf(record);
    if (id.github_run_id !== Number(trust.run_id) ||
        id.github_run_attempt !== Number(trust.attempt) ||
        id.workflow_id !== trust.workflow_id || id.repository !== trust.repository) {
      reject('source workflow/run/attempt/repository mismatch');
    }
    const rel = relative(record), data = fs.readFileSync(file);
    if (planned.has(rel)) {
      if (!planned.get(rel).bytes.equals(data)) reject('duplicate logical metrics path has divergent content');
      continue;
    }
    planned.set(rel,{bytes:data,record});
    records.set(rel,record);
  }
  // Resolve all traces against canonical summaries before any writes.
  for (const [rel, item] of planned) {
    if (item.record.kind !== 'agent_execution_trace') continue;
    const summaryPath = 'raw/workflows/'+rel.slice('raw/events/'.length);
    const summary = records.get(summaryPath) ??
      (fs.existsSync(safePath(metricsDir,summaryPath)) ? content(safePath(metricsDir,summaryPath)) : null);
    if (!summary || summary.kind !== 'agent_workflow_run') reject('trace without matching canonical run summary');
    validateTraceSource(item.record, summary);
  }
  // Preflight immutable collisions, then copy. No remotely persisted partial
  // results: the trusted GitHub job commits/pushes only if the whole step succeeds.
  for (const [rel,item] of planned) {
    const dest = safePath(metricsDir,rel);
    if (fs.existsSync(dest) && !fs.readFileSync(dest).equals(item.bytes)) reject('immutable metrics collision: '+rel);
  }
  let changed = 0;
  for (const [rel,item] of planned) {
    const dest = safePath(metricsDir,rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,item.bytes,{flag:'wx'});
    changed++;
  }
  return { found:incoming.length,changed };
}
export function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'agent-metrics-ingest-'));
  try {
    const incoming=path.join(dir,'incoming'),store=path.join(dir,'metrics');
    fs.mkdirSync(incoming);fs.mkdirSync(store);
    const trust={run_id:321,attempt:1,workflow_id:'requirement-acceptance',repository:'BestNathan/nession'};
    const run=buildAgentWorkflowTelemetry({
      workflow_id:trust.workflow_id,github_run_id:321,github_run_attempt:1,
      repository:trust.repository,unique_run_name:'321-1-issue-1692-acceptance-cursor',
      task:{id:'issue-1692-acceptance',type:'acceptance',issue:1692,target_ref:'a'.repeat(40)},
      agent:{provider:'cursor',id:'legacy-acceptance-cursor',role:'acceptor',harness_sha256:'b'.repeat(64)},
      timing:{started_at:'2026-10-13T05:00:00.000Z',finished_at:'2026-10-13T05:01:00.000Z'},
    });
    const trace=buildExecutionTrace(run,[],{skills:'unobserved',tools:'unobserved'});
    const summaryFile=path.join(incoming,'summary.json'),traceFile=path.join(incoming,'trace.json');
    fs.writeFileSync(summaryFile,JSON.stringify(run));
    fs.writeFileSync(traceFile,JSON.stringify(trace));
    const src=()=>stageAgentMetrics(incoming,store,trust);
    assert.deepEqual(src(),{found:2,changed:2});
    assert.deepEqual(src(),{found:2,changed:0});
    const alter={...trace, task:{...trace.task,issue:999}};
    fs.writeFileSync(traceFile,JSON.stringify(alter));
    assert.throws(src,/trace\/run summary task mismatch|does not match source/);
    fs.writeFileSync(traceFile,JSON.stringify(trace));
    fs.writeFileSync(traceFile,JSON.stringify({...trace,events:[{kind:'evil'}]}));
    assert.throws(src,/invalid event/);
    fs.writeFileSync(traceFile,JSON.stringify(trace));
    assert.throws(()=>stageAgentMetrics(incoming,store,{...trust,attempt:2}),/source workflow/);
    fs.writeFileSync(summaryFile,JSON.stringify({...run,result:{status:'modified'}}));
    assert.throws(src,/immutable metrics collision/);
    fs.writeFileSync(summaryFile,JSON.stringify(run));
    fs.unlinkSync(summaryFile);
    const emptyStore=path.join(dir,'empty');fs.mkdirSync(emptyStore);
    assert.throws(()=>stageAgentMetrics(incoming,emptyStore,trust),/trace without matching/);
    fs.writeFileSync(summaryFile,JSON.stringify(run));
    const payload={...trace,unexpected:'raw prompt'};
    fs.writeFileSync(traceFile,JSON.stringify(payload));
    assert.throws(src,/unexpected or invalid/);
    fs.writeFileSync(traceFile,JSON.stringify(trace));
    assert.deepEqual(src(),{found:2,changed:0});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  console.log('Agent Metrics trusted immutable ingest + trace replay and negative fixtures passed');
}
if (process.argv[2]==='self-test') selfTest();
else if (process.argv[2]==='stage') {
  const [source,store,run_id,attempt,workflow_id,repository]=process.argv.slice(3);
  if (!source || !store) reject('usage: stage SOURCE STORE RUN_ID ATTEMPT WORKFLOW_ID REPOSITORY');
  console.log(JSON.stringify(stageAgentMetrics(source,store,{run_id,attempt,workflow_id,repository})));
} else if (process.argv[1]?.endsWith('agent-telemetry-ingest.mjs')) reject('usage: self-test | stage ...');
