import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeExecutionEvent, normalizeProviderEvent } from './execution-event.mjs';

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
function stringOrNull(value, name) { if (value != null) id(value, name, NATIVE); }
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

export function traceStoragePath(trace) {
  validateExecutionTrace(trace);
  return ['raw','events',trace.identity.workflow_id,trace.timing.started_at.slice(0,10),
    trace.identity.unique_run_name + '.json'].join('/');
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
  if (!Array.isArray(nativeEvents)) fail('native events must be an array');
  const identity = { role: run.agent.role, agent_id: run.agent.id, issue: run.task.issue,
    github_run_id: run.identity.github_run_id, github_run_attempt: run.identity.github_run_attempt };
  const events = [];
  for (const input of nativeEvents) {
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
  const rejected = (mutate, message) => assert.throws(() => validateExecutionTrace(mutate(structuredClone(trace))), message);
  rejected(t => {t.events[0].data.tool.args={api_key:'secret'};return t}, /unexpected/);
  rejected(t => {t.events[0].data.prompt='do this';return t}, /unexpected/);
  rejected(t => {t.events[0].sequence=1;return t}, /sequence/);
  rejected(t => {t.events[0].identity.issue=1;return t}, /does not match/);
  rejected(t => {t.identity.github_run_attempt=2;return t}, /does not match/);
  rejected(t => {t.events.push({...t.events[0],type:'unknown',sequence:1});return t}, /invalid event/);
  rejected(t => {t.coverage.skills='zero';return t}, /coverage/);
  rejected(t => {t.events[0].data.tool.native_name='read\nSECRET';return t}, /native tool/);
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
  assert.ok(!JSON.stringify(q).includes('/private'));
  assert.throws(() => buildExecutionTrace({...summary,agent:{...summary.agent,id:null}},[]),/agent.id/);
  console.log('agent execution trace: schema, lifecycle, source identity and redaction fixtures passed');
}
