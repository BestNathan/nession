import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeExecutionEvent, normalizeProviderEvent, canonicalToolId } from './execution-event.mjs';

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const NATIVE = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/;
const HEX = /^[a-f0-9]{64}$/;
const TYPES = new Set(['model.usage', 'tool.started', 'tool.completed', 'tool.failed',
  'skill.loaded', 'skill.invoked', 'mcp.tool.completed', 'checkpoint.saved',
  'checkpoint.restored', 'agent.handoff']);
const OBSERVATION = new Set(['native-event', 'host-tool', 'loader', 'trusted-workflow']);
const COVERAGE = new Set(['observed', 'partial', 'unobserved']);
const MAX_EVENTS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;

function fail(message) { throw new Error('agent execution trace: ' + message); }
function keysOnly(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k))) fail('unexpected or invalid ' + name + ' fields');
}
function tokenInteger(v, label) {
  if (v != null && (!Number.isSafeInteger(v) || v < 0)) fail('invalid numeric metric ' + label);
}
function id(v, label, pattern = ID) {
  if (typeof v !== 'string' || !pattern.test(v)) fail('invalid ' + label);
}
function stringOrNull(value, name) { if (value != null) id(value, name, /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/); }
function validateEvent(e, run) {
  keysOnly(e, ['schema_version','kind','type','sequence','identity','data'], 'event');
  if (e.schema_version !== 1 || e.kind !== 'agent_execution_event' || !TYPES.has(e.type) ||
      !Number.isSafeInteger(e.sequence) || e.sequence < 0) fail('invalid event header');
  keysOnly(e.identity, ['agent_id','role','issue','github_run_id','github_run_attempt'], 'event identity');
  for (const k of ['agent_id','role','issue','github_run_id','github_run_attempt']) {
    const actual = e.identity[k];
    const expected = k === 'agent_id' ? run.agent.id : k === 'role' ? run.agent.role :
      k === 'issue' ? run.task.issue : run.identity[k];
    if (actual !== expected) fail('event does not match source ' + k);
  }
  const allowed = {
    'model.usage': ['usage','request_id','observation'],
    'tool.started': ['call_id','tool','observation'],
    'tool.completed': ['call_id','tool','status','duration_ms','observation'],
    'tool.failed': ['call_id','tool','status','duration_ms','observation'],
    'skill.loaded': ['skill_id','observation'],
    'skill.invoked': ['skill_id','observation'],
    'mcp.tool.completed': ['call_id','tool','server','status','duration_ms','observation'],
    'checkpoint.saved': ['checkpoint_id','observation'],
    'checkpoint.restored': ['checkpoint_id','observation'],
    'agent.handoff': ['to_role','result','observation'],
  };
  keysOnly(e.data, allowed[e.type], 'event data');
  if (!OBSERVATION.has(e.data.observation)) fail('invalid event provenance');
  const d = e.data;
  if (e.type.startsWith('tool.') || e.type === 'mcp.tool.completed') {
    stringOrNull(d.call_id, 'tool call_id');
    if (d.call_id == null) fail('missing tool call_id');
    keysOnly(d.tool, ['id','native_name','server','tool','observed'], 'tool descriptor');
    if (d.tool.id != null) id(d.tool.id, 'canonical tool id');
    if (d.tool.native_name != null) id(d.tool.native_name, 'native tool', NATIVE);
    if (d.tool.server != null) id(d.tool.server, 'mcp server', NATIVE);
    if (d.tool.tool != null) id(d.tool.tool, 'mcp tool', NATIVE);
    if (d.tool.observed != null && typeof d.tool.observed !== 'boolean') fail('invalid tool observation');
    if (d.tool.native_name == null && d.tool.id == null) fail('unidentifiable tool');
    if (e.type !== 'tool.started') {
      if (!['success','failed','completed','error'].includes(d.status)) fail('invalid tool result status');
      tokenInteger(d.duration_ms, 'tool duration');
    }
  }
  if (e.type === 'model.usage') {
    if (d.usage !== null) {
      keysOnly(d.usage, ['input','output','cache_read','cache_write','reasoning'], 'usage');
      for (const [k,v] of Object.entries(d.usage)) tokenInteger(v, k);
    }
    if (d.request_id != null) stringOrNull(d.request_id, 'request_id');
  }
  if (e.type.startsWith('skill.')) id(d.skill_id, 'skill_id');
  if (e.type.startsWith('checkpoint.')) id(d.checkpoint_id, 'checkpoint_id');
  if (e.type === 'agent.handoff') {
    id(d.to_role, 'handoff role');
    id(d.result, 'handoff result');
  }
  if (e.type === 'mcp.tool.completed') id(d.server, 'MCP server', NATIVE);
  return e;
}

export function validateExecutionTrace(trace) {
  keysOnly(trace, ['schema_version','kind','identity','task','agent','timing','coverage','events'], 'trace');
  if (trace.schema_version !== 1 || trace.kind !== 'agent_execution_trace') fail('unsupported trace schema');
  keysOnly(trace.identity, ['workflow_id','github_run_id','github_run_attempt','unique_run_name','repository'], 'trace identity');
  for (const k of ['workflow_id','unique_run_name']) id(trace.identity[k], k);
  for (const k of ['github_run_id','github_run_attempt']) {
    if (!Number.isSafeInteger(trace.identity[k]) || trace.identity[k] < 1) fail('invalid ' + k);
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trace.identity.repository ?? '')) fail('invalid repository');
  keysOnly(trace.task, ['id','type','issue','target_sha'], 'task');
  for (const k of ['id','type']) id(trace.task[k], 'task.' + k);
  if (!Number.isSafeInteger(trace.task.issue) || trace.task.issue < 1) fail('invalid Issue');
  if (trace.task.target_sha != null && !/^[0-9a-f]{40}$/.test(trace.task.target_sha)) fail('invalid target_sha');
  keysOnly(trace.agent, ['id','role','provider','harness_sha256'], 'agent');
  for (const k of ['id','role','provider']) id(trace.agent[k], 'agent.' + k);
  if (trace.agent.harness_sha256 != null && !HEX.test(trace.agent.harness_sha256)) fail('invalid harness digest');
  keysOnly(trace.timing, ['started_at','finished_at'], 'timing');
  const started = Date.parse(trace.timing.started_at ?? '');
  if (!Number.isFinite(started) || new Date(started).toISOString() !== trace.timing.started_at) fail('invalid start timestamp');
  if (trace.timing.finished_at != null &&
      (!Number.isFinite(Date.parse(trace.timing.finished_at)) || Date.parse(trace.timing.finished_at) < started)) {
    fail('invalid finish timestamp');
  }
  keysOnly(trace.coverage, ['model','tools','skills','mcp'], 'coverage');
  for (const family of ['model','tools','skills','mcp']) {
    if (!COVERAGE.has(trace.coverage[family])) fail('missing/invalid ' + family + ' coverage');
  }
  if (!Array.isArray(trace.events) || trace.events.length > MAX_EVENTS) fail('too many events');
  let sequence = -1;
  for (const e of trace.events) {
    validateEvent(e, trace);
    if (e.sequence !== sequence + 1) fail('trace event sequence gap or duplicate');
    sequence = e.sequence;
  }
  if (Buffer.byteLength(JSON.stringify(trace)) > MAX_BYTES) fail('trace exceeds maximum size');
  return trace;
}

export function buildExecutionTrace(run, events, coverage = {}) {
  if (run?.kind !== 'agent_workflow_run') fail('source must be a canonical Agent run');
  const trace = {
    schema_version: 1,
    kind: 'agent_execution_trace',
    identity: Object.fromEntries(['workflow_id','github_run_id','github_run_attempt','unique_run_name','repository']
      .map(key => [key, run.identity[key]])),
    task: { id: run.task.id, type: run.task.type, issue: run.task.issue,
      target_sha: run.task.target_ref ?? null },
    agent: { id: run.agent.id, role: run.agent.role, provider: run.agent.provider,
      harness_sha256: run.agent.harness_sha256 },
    timing: { started_at: run.timing.started_at, finished_at: run.timing.finished_at },
    coverage: {
      model: coverage.model ?? 'unobserved',
      tools: coverage.tools ?? 'unobserved',
      skills: coverage.skills ?? 'unobserved',
      mcp: coverage.mcp ?? 'unobserved',
    },
    events,
  };
  return validateExecutionTrace(trace);
}

export function validateTraceSource(trace, summary) {
  validateExecutionTrace(trace);
  if (summary?.schema_version !== 1 || summary.kind !== 'agent_workflow_run') fail('missing canonical run summary');
  for (const field of ['workflow_id','github_run_id','github_run_attempt','unique_run_name','repository']) {
    if (trace.identity[field] !== summary.identity?.[field]) fail('trace/run summary source mismatch: ' + field);
  }
  if (trace.task.id !== summary.task?.id || trace.task.type !== summary.task?.type ||
      trace.task.issue !== summary.task?.issue ||
      trace.task.target_sha !== (summary.task.target_ref ?? null)) fail('trace/run summary task mismatch');
  for (const field of ['id','role','provider','harness_sha256']) {
    if (trace.agent[field] !== (summary.agent?.[field] ?? null)) fail('trace/run summary agent mismatch: ' + field);
  }
  if (trace.timing.started_at !== summary.timing?.started_at) fail('trace/run summary start mismatch');
  return true;
}

export function traceStoragePath(trace) {
  validateExecutionTrace(trace);
  return ['raw','events',trace.identity.workflow_id,trace.timing.started_at.slice(0,10),
    trace.identity.unique_run_name + '.json'].join('/');
}

export function summarizeExecutionTrace(trace) {
  validateExecutionTrace(trace);
  function count(type, key) {
    const rows = trace.events.filter(e => e.type === type);
    return {
      observed: trace.coverage[key] !== 'unobserved',
      completeness: trace.coverage[key],
      observed_count: rows.length,
    };
  }
  const toolStarts = trace.events.filter(e => e.type === 'tool.started');
  const toolEnds = trace.events.filter(e => ['tool.completed','tool.failed'].includes(e.type));
  const byLogicalName = {};
  for (const e of toolStarts) {
    const name = e.data.tool.id ?? 'unmapped';
    byLogicalName[name] = (byLogicalName[name] ?? 0) + 1;
  }
  const bySkill = {};
  for (const e of trace.events.filter(e => e.type === 'skill.invoked')) {
    const id = e.data.skill_id;
    bySkill[id] = (bySkill[id] ?? 0) + 1;
  }
  const model = count('model.usage', 'model');
  const tools = count('tool.started','tools');
  const skills = count('skill.invoked','skills');
  const mcp = count('mcp.tool.completed','mcp');
  const knownLatencies = toolEnds.map(e => e.data.duration_ms).filter(Number.isFinite);
  return {
    schema_version: 1, kind: 'agent_execution_trace_summary',
    identity: trace.identity, agent: trace.agent, task: trace.task, coverage: trace.coverage,
    model: {
      ...model, // Number of observed usage events is not a guaranteed model request count.
      request_count: null,
    },
    tools: {
      ...tools, by_logical_name: byLogicalName,
      observed_completed: toolEnds.filter(e => e.type === 'tool.completed').length,
      observed_failed: toolEnds.filter(e => e.type === 'tool.failed').length,
      measured_duration_ms: knownLatencies.length ? knownLatencies.reduce((a,b)=>a+b,0) : null,
    },
    skills: { ...skills, loaded: trace.events.filter(e => e.type === 'skill.loaded').length,
      by_skill: bySkill },
    mcp,
  };
}

export function writeExecutionTrace(file, trace) {
  validateExecutionTrace(trace);
  mkdirSync(dirname(file), { recursive:true });
  writeFileSync(file, JSON.stringify(trace, null, 2) + '\n');
  return trace;
}

// Per-model/provider conversion happens before writing an untrusted telemetry artifact.
// No native event input block or final model message is ever copied to the trace.
export function normalizeNativeTrace(provider, nativeEvents, run, coverage) {
  if (!['cursor', 'claude-code'].includes(provider) || !Array.isArray(nativeEvents)) {
    fail('unsupported native source');
  }
  const identity = { role: run.agent.role, agent_id: run.agent.id, issue: run.task.issue,
    github_run_id: run.identity.github_run_id, github_run_attempt: run.identity.github_run_attempt };
  const events = [];
  const calls = new Map();
  let assistantUsageSeen = false;
  const emit = (type, data) => events.push(makeExecutionEvent(identity, type, events.length, data));
  for (const input of nativeEvents) {
    if (provider === 'claude-code') {
      const content = input?.message?.content;
      if (input?.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use' || !block.id || !block.name) continue;
          const tool = canonicalToolId('claude-code', block.name);
          const callId = String(block.id);
          calls.set(callId, tool);
          emit('tool.started', { call_id: callId, tool, observation: 'native-event' });
        }
        // Per-message model usage is observed independently from the final
        // aggregate result. Do not sum both into model request count.
        if (input.message.usage) {
          const usage = normalizeProviderEvent('claude-code',
            { type:'result', usage:input.message.usage }, identity, events.length);
          if (usage) { events.push(usage); assistantUsageSeen = true; }
        }
        continue;
      }
      if (input?.type === 'user' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          const callId = String(block.tool_use_id ?? '');
          const tool = calls.get(callId);
          if (!tool) continue; // result without an observed start is not evidence of lifecycle.
          const failed = block.is_error === true;
          emit(failed ? 'tool.failed' : 'tool.completed', {
            call_id:callId, tool, status:failed ? 'error' : 'completed',
            duration_ms:null, observation:'native-event',
          });
          calls.delete(callId);
        }
        continue;
      }
      if (input?.type === 'result' && assistantUsageSeen) continue;
    }
    const normalized = normalizeProviderEvent(provider, input, identity, events.length);
    if (normalized) events.push(normalized);
  }
  return buildExecutionTrace(run, events, coverage);
}

export function selfTest() {
  const context = { role:'developer', agent_id:'dev-cursor-01', issue:1692,
    github_run_id:101, github_run_attempt:1 };
  const summary = {
    schema_version:1, kind:'agent_workflow_run',
    identity:{ workflow_id:'agent-develop', github_run_id:101,github_run_attempt:1,
      unique_run_name:'101-1-issue-1692-developer',repository:'BestNathan/nession' },
    task:{id:'issue-1692-developer',type:'develop',issue:1692,target_ref:'a'.repeat(40)},
    agent:{id:'dev-cursor-01',role:'developer',provider:'cursor',harness_sha256:'b'.repeat(64)},
    timing:{started_at:'2026-10-13T01:00:00.000Z',finished_at:'2026-10-13T01:01:00.000Z'},
  };
  const e = makeExecutionEvent(context, 'tool.started', 0, {call_id:'call1',
    tool:{id:'repo.read',native_name:'read',observed:true},observation:'native-event'});
  const trace = buildExecutionTrace(summary, [e], {tools:'observed'});
  assert.equal(traceStoragePath(trace), 'raw/events/agent-develop/2026-10-13/101-1-issue-1692-developer.json');
  assert.equal(validateExecutionTrace(trace), trace);
  assert.equal(validateTraceSource(trace, summary), true);
  assert.equal(summarizeExecutionTrace(trace).tools.by_logical_name['repo.read'], 1);
  assert.equal(summarizeExecutionTrace(trace).skills.completeness, 'unobserved');
  assert.equal(summarizeExecutionTrace(trace).model.request_count, null);
  const emptyTrace = buildExecutionTrace(summary, []);
  assert.equal(summarizeExecutionTrace(emptyTrace).tools.observed, false);
  assert.equal(summarizeExecutionTrace(emptyTrace).tools.observed_count, 0);
  assert.throws(() => validateTraceSource(trace, { ...summary, task: { ...summary.task, issue: 1693 } }), /task mismatch/);
  assert.throws(() => validateTraceSource(trace, { ...summary, identity: { ...summary.identity, github_run_attempt: 2 } }), /source mismatch/);
  const rejected = (mutate, message) => assert.throws(() => validateExecutionTrace(mutate(structuredClone(trace))), message);
  rejected(t => {t.events[0].data.tool.args={api_key:'secret'};return t}, /unexpected/);
  rejected(t => {t.events[0].data.prompt='do this';return t}, /unexpected/);
  rejected(t => {t.events[0].sequence=1;return t}, /sequence/);
  rejected(t => {t.events[0].identity.issue=1;return t}, /does not match/);
  rejected(t => {t.identity.github_run_attempt=2;return t}, /does not match/);
  rejected(t => {t.events.push({...t.events[0],type:'unknown',sequence:1});return t}, /invalid event/);
  rejected(t => {t.coverage.skills='zero';return t}, /coverage/);
  rejected(t => {t.events[0].data.tool.native_name='read\nSECRET';return t}, /native tool/);
  const numericCall = structuredClone(trace);
  numericCall.events[0].data.call_id = '123e4567-e89b-12d3-a456-426614174000';
  validateExecutionTrace(numericCall);
  const u = normalizeNativeTrace('cursor', [{type:'tool_call',status:'running',id:'x1',
    name:'read',input:{password:'dont store'}},
    {type:'usage',inputTokens:5,outputTokens:2}], summary, {tools:'observed',model:'observed'});
  assert.equal(u.events.length,2);
  assert.equal(u.events[0].data.tool.id,'repo.read');
  assert.ok(!JSON.stringify(u).includes('dont store'));
  const claude = {...summary,agent:{...summary.agent,provider:'claude-code'}};
  const q = normalizeNativeTrace('claude-code', [{type:'assistant',message:{content:[
    {type:'tool_use',id:'x1',name:'Read',input:{file_path:'/private'}}]}}],
    claude, {tools:'partial'});
  assert.equal(q.events[0].data.tool.id, u.events[0].data.tool.id);
  assert.equal(q.coverage.skills,'unobserved');
  const multi = normalizeNativeTrace('claude-code', [
    {type:'assistant', message:{ content:[
      {type:'tool_use', id:'m1', name:'Read', input:{file_path:'/private/a'}},
      {type:'tool_use', id:'m2', name:'Grep', input:{pattern:'SECRET'}}],
      usage:{input_tokens:15, output_tokens:4} }},
    {type:'user', message:{content:[
      {type:'tool_result',tool_use_id:'m1',content:'PRIVATE OUTPUT'},
      {type:'tool_result',tool_use_id:'m2',is_error:true,content:'PRIVATE FAILURE'}]}}
  ], claude, {model:'partial',tools:'observed'});
  assert.equal(multi.events.filter(e => e.type === 'tool.started').length, 2);
  assert.equal(multi.events.filter(e => e.type === 'tool.completed').length, 1);
  assert.equal(multi.events.filter(e => e.type === 'tool.failed').length, 1);
  assert.equal(multi.events.filter(e => e.type === 'model.usage').length, 1);
  assert.ok(!JSON.stringify(multi).includes('PRIVATE'));
  assert.ok(!JSON.stringify(multi).includes('SECRET'));

  assert.ok(!JSON.stringify(q).includes('/private'));
  assert.throws(() => buildExecutionTrace({...summary,agent:{...summary.agent,id:null}},[]),/agent.id/);
  console.log('agent execution trace: schema, lifecycle, source identity and redaction fixtures passed');
}
