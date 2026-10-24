#!/usr/bin/env node
// Real Provider synthetic Developer canary: NO repo edits or publisher token.
// The selected Claude CLI is restricted to the disposable working directory.
// Never log/commit raw model output, tool inputs, prompt or gateway secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {claudeCliToolPolicy} from './harness/native.mjs';
import {qwenDeveloperModel,qwenGatewayEndpoint} from './orchestration/qwen-developer-policy.mjs';
import {normalizeClaudeUsage} from './providers/claude-code.mjs';
import {parseNativeEvents} from './providers/claude-stream.mjs';
import {providerScopedRunName} from './telemetry/run-name.mjs';
import {normalizeNativeTrace,writeExecutionTrace} from './telemetry/execution-trace.mjs';
import {buildAgentWorkflowTelemetry,writeAgentWorkflowTelemetry} from '../../agent-workflow-telemetry.mjs';

const SOURCE='module.exports = (a, b) => a - b;\n';
const EXPECTED='module.exports = (a, b) => a + b;\n';
const TASK='issue-1664-dev-qwen-canary';
const ISSUE=1664;
const SHA=/^[a-f0-9]{40}$/;
const PROMPT='Read calc.js using the Read tool. The function incorrectly subtracts two numbers. '+
  'Use the Edit tool to change ONLY the minus operator to plus, preserving all other bytes. '+
  'Do not create or edit any other file. Finish with a short confirmation. '+
  'Do not use Bash, network tools, plugins or external tools.';
function fail(message){throw new Error('Qwen Developer Canary: '+message);}
function providerModel(env){return qwenDeveloperModel(env);}
export function checkSyntheticEdit(root,events){
  if(!Array.isArray(events))fail('missing real Provider event sequence');
  const tools=events.filter(x=>x?.type==='assistant'&&Array.isArray(x?.message?.content))
    .flatMap(x=>x.message.content)
    .filter(block=>block?.type==='tool_use'&&typeof block.id==='string');
  if(!tools.some(x=>x.name==='Read') || !tools.some(x=>x.name==='Edit')) {
    fail('real Provider Read and Edit tool events were not observed');
  }
  if(tools.some(x=>!['Read','Edit','Write'].includes(x.name)))fail('unapproved native tool invoked');
  const names=fs.readdirSync(root);
  if(names.length!==1||names[0]!=='calc.js')fail('unexpected workspace mutation');
  const target=path.join(root,'calc.js');
  if(!fs.lstatSync(target).isFile()||fs.lstatSync(target).isSymbolicLink()) {
    fail('modified fixture is not a regular file');
  }
  // This deliberately does NOT eval/require/execute model-edited JavaScript.
  if(fs.readFileSync(target,'utf8')!==EXPECTED)fail('exact synthetic code repair not observed');
  return {edit_verified:true,native_read:true,native_edit:true};
}
function canaryArgs(model){
  return ['-p',PROMPT,'--output-format','stream-json','--verbose',
    '--no-session-persistence','--max-turns','8','--model',model,
    '--strict-mcp-config',...claudeCliToolPolicy(['Read','Edit','Write'],{restricted:true})];
}
function canaryIdentity(env,startedAt,finishedAt,envelope,events,result,{stage=false}={}){
  const {GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_SHA,GITHUB_REPOSITORY}=env;
  if(!/^[1-9]\d*$/.test(GITHUB_RUN_ID??'')||
      !/^[1-9]\d*$/.test(GITHUB_RUN_ATTEMPT??'')||
      !SHA.test(GITHUB_SHA??'')||GITHUB_REPOSITORY!=='BestNathan/nession') {
    fail('trusted main source identity is missing');
  }
  const workflowId=stage?'agent-staging-developer-canary':'agent-provider-smoke';
  const taskId=stage?'issue-2319-staging-qwen-canary':TASK;
  const targetRef=stage?env.STAGING_TARGET_SHA:GITHUB_SHA;
  if(stage&&(!SHA.test(targetRef??'')||
    env.GITHUB_WORKFLOW!=='Agent / Staging Developer Canary'||
    env.GITHUB_EVENT_NAME!=='workflow_run'||env.GITHUB_REF!=='refs/heads/main'||
    env.GITHUB_RUN_ATTEMPT!=='1'))fail('staging Worker source identity missing');
  const nativeToolNames=events.filter(x=>x?.type==='assistant')
    .flatMap(x=>x.message?.content??[])
    .filter(x=>x?.type==='tool_use')
    .map(x=>x.name);
  const started=new Date(startedAt).getTime(),ended=new Date(finishedAt).getTime();
  return buildAgentWorkflowTelemetry({
    workflow_id:workflowId,github_workflow:stage?'Agent / Staging Developer Canary':'Agent / Provider Smoke',
    job:'qwen-developer-canary',repository:GITHUB_REPOSITORY,event:stage?'workflow_run':'push',
    github_run_id:Number(GITHUB_RUN_ID),github_run_attempt:Number(GITHUB_RUN_ATTEMPT),
    unique_run_name:providerScopedRunName({workflowId,
      runId:GITHUB_RUN_ID,runAttempt:GITHUB_RUN_ATTEMPT,taskId,provider:'claude-code'}),
    task:{id:taskId,type:'develop',issue:stage?2319:ISSUE,target_ref:targetRef},
    agent:{provider:'claude-code',id:'dev-qwen-01',role:'developer',
      model:{id:providerModel(env),request_model:providerModel(env)},
      run_id:envelope?.session_id??null,status:result.edit_verified?'finished':'error'},
    execution:{turns:envelope?.num_turns??null,model_requests:null,
      tool_calls:nativeToolNames,tools_observed:events.some(x=>x?.type==='assistant'&&Array.isArray(x.message?.content))},
    tokens:normalizeClaudeUsage(envelope),
    cost:{raw_usd:null,charged_usd:null,estimated_usd:null},
    timing:{started_at:startedAt,finished_at:finishedAt,agent_duration_ms:ended-started},
    result:{status:result.edit_verified?(stage?'staging-canary-pass':'canary-pass'):'canary-error'},
  });
}
async function run(dir,{stage=false}={}){
  const env=process.env,model=providerModel(env);
  if(env.GITHUB_REPOSITORY!=='BestNathan/nession'||env.GITHUB_REF!=='refs/heads/main'||
      !SHA.test(env.GITHUB_SHA??'')||
      (stage ? (env.GITHUB_WORKFLOW!=='Agent / Staging Developer Canary'||
        env.GITHUB_EVENT_NAME!=='workflow_run'||env.GITHUB_RUN_ATTEMPT!=='1'||
        !SHA.test(env.STAGING_TARGET_SHA??'')) : env.GITHUB_EVENT_NAME!=='push')) {
    fail('only admitted trusted main Workflow may run credentialed Developer Canary');
  }
  qwenGatewayEndpoint(env);
  if(!dir||!path.isAbsolute(dir))fail('metrics directory must be absolute');
  const root=fs.mkdtempSync(path.join(env.RUNNER_TEMP||os.tmpdir(),'qwen-developer-canary-'));
  let events=[],envelope=null,sourceResult={edit_verified:false},error=null;
  const startedAt=new Date().toISOString();
  try {
    fs.writeFileSync(path.join(root,'calc.js'),SOURCE,{flag:'wx',mode:0o600});
    const argv=canaryArgs(model);
    const proc=spawnSync('claude',argv,{
      cwd:root,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024,
      env:{...env,DISABLE_AUTOUPDATER:'1',ANTHROPIC_MODEL:model,
        ANTHROPIC_DEFAULT_SONNET_MODEL:model},
    });
    if(proc.error||proc.status!==0)fail('restricted Claude Code CLI failed (no raw output logged)');
    const parsed=parseNativeEvents(proc.stdout);
    events=parsed.events;envelope=parsed.envelope;
    if(envelope.is_error===true)fail('Provider returned error');
    sourceResult=checkSyntheticEdit(root,events);
    console.log('Qwen Developer Canary: authenticated CLI edit and exact synthetic repair verified');
  }catch(e){error=e;console.error(e.message);}
  finally{
    fs.mkdirSync(dir,{recursive:true});
    const finishedAt=new Date().toISOString();
    const summary=canaryIdentity(env,startedAt,finishedAt,envelope,events,sourceResult,{stage});
    writeAgentWorkflowTelemetry(path.join(dir,'agent-telemetry.json'),summary);
    const trace=normalizeNativeTrace('claude-code',events,summary,{
      model:events.some(e=>e.type==='assistant'&&e.message?.usage)?'observed':'unobserved',
      tools:events.some(e=>e.type==='assistant'&&e.message?.content?.some(b=>b.type==='tool_use'))?'partial':'unobserved',
      skills:'unobserved',mcp:'unobserved',
    });
    writeExecutionTrace(path.join(dir,'agent-execution-trace.json'),trace);
    fs.rmSync(root,{recursive:true,force:true});
  }
  if(error)throw error;
}
function selfTest(){
  assert.equal(providerModel({ANTHROPIC_MODEL:'qwen3.7-plus'}),'qwen3.7-plus');
  assert.throws(()=>providerModel({ANTHROPIC_MODEL:'claude-sonnet-5'}),/Qwen/);
  const a=canaryArgs('qwen3.7-plus').join(' ');
  for(const flag of ['--restricted','--tools','--permission-mode dontAsk','--strict-mcp-config',
    '--disallowedTools mcp__*','--no-session-persistence']){
    assert.ok(a.includes(flag),'required Claude flag absent: '+flag);
  }
  const stageEnv={
    GITHUB_REPOSITORY:'BestNathan/nession',GITHUB_REF:'refs/heads/main',
    GITHUB_WORKFLOW:'Agent / Staging Developer Canary',
    GITHUB_EVENT_NAME:'workflow_run',GITHUB_RUN_ID:'401',
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'b'.repeat(40),
    STAGING_TARGET_SHA:'a'.repeat(40),ANTHROPIC_MODEL:'qwen3.7-plus',
  };
  const stageRecord=canaryIdentity(stageEnv,'2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:01.000Z',{num_turns:2,session_id:'synthetic'},[],
    {edit_verified:true},{stage:true});
  assert.equal(stageRecord.identity.workflow_id,'agent-staging-developer-canary');
  assert.equal(stageRecord.task.target_ref,stageEnv.STAGING_TARGET_SHA);
  assert.equal(stageRecord.result.status,'staging-canary-pass');
  assert.throws(()=>canaryIdentity({...stageEnv,GITHUB_EVENT_NAME:'pull_request_target'},
    '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',{},[],
    {edit_verified:true},{stage:true}),/staging Worker source/);
  const argv=canaryArgs('qwen3.7-plus');
  const nativeVisible=argv[argv.indexOf('--tools')+1];
  assert.equal(nativeVisible,'Edit,Read,Write');
  assert.ok(!nativeVisible.includes('Bash'));
  assert.ok(!argv.includes('bypassPermissions'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-canary-test-'));
  const good=[{type:'assistant',message:{content:[{type:'tool_use',id:'r1',name:'Read'},
    {type:'tool_use',id:'e1',name:'Edit'}]}}];
  try{
    fs.writeFileSync(path.join(root,'calc.js'),EXPECTED);
    assert.equal(checkSyntheticEdit(root,good).edit_verified,true);
    assert.throws(()=>checkSyntheticEdit(root,[]),/not observed/);
    assert.throws(()=>checkSyntheticEdit(root,[{type:'assistant',message:{content:[
      ...good[0].message.content,{type:'tool_use',id:'b1',name:'Bash'}]}}]),/unapproved/);
    fs.writeFileSync(path.join(root,'other.txt'),'extra');
    assert.throws(()=>checkSyntheticEdit(root,good),/unexpected workspace mutation/);
    fs.unlinkSync(path.join(root,'other.txt'));
    fs.writeFileSync(path.join(root,'calc.js'),SOURCE);
    assert.throws(()=>checkSyntheticEdit(root,good),/repair not observed/);
    assert.throws(()=>parseNativeEvents('{not-json}'),/malformed/);
    assert.equal(parseNativeEvents('{"type":"result","num_turns":2}\n').envelope.num_turns,2);
    assert.throws(()=>parseNativeEvents('{}\n'),/one Provider result/);
    console.log('Qwen Developer Canary: strict CLI flags, native events and mutation denial fixtures passed');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  (process.argv[2]==='self-test'?Promise.resolve(selfTest()):
    process.argv[2]==='run'?run(process.argv[3]):
    process.argv[2]==='staging'?run(process.argv[3],{stage:true}):
    Promise.reject(Error('usage: self-test | run METRICS_DIR | staging METRICS_DIR')))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
