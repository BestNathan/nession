#!/usr/bin/env node
// Real Provider synthetic Developer canary: NO repo edits or publisher token.
// The selected Claude CLI is restricted to the disposable working directory.
// Never log/commit raw model output, tool inputs, prompt or gateway secrets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {claudeCliToolPolicy} from './harness/native.mjs';
import {qwenDeveloperModel,qwenGatewayEndpoint} from './orchestration/qwen-developer-policy.mjs';
import {runClaudeCli,normalizeClaudeUsage} from './providers/claude-code.mjs';
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
const RESUME_PROMPT='From the PREVIOUS conversation, reply ONLY with the exact '+
  '32-character hexadecimal marker you were asked to remember. Do not invent one.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message){throw new Error('Qwen Developer Canary: '+message);}
function providerModel(env){return qwenDeveloperModel(env);}
// A resume telemetry record must carry the exact signed checkpoint commitment
// it consumed, so acceptance can bind the resumed Run to the stored Session
// instead of trusting a separately reported model.
function checkpointCommitment(env){
  return /^[1-9]\d*$/.test(env.STAGING_CHECKPOINT_VERSION??'')&&
    /^[a-f0-9]{64}$/.test(env.STAGING_CHECKPOINT_CIPHERTEXT_SHA??'');
}
function stagingTask(env){
  const base={dispatch_id:env.STAGING_DISPATCH_ID,phase:env.STAGING_PHASE,
    dispatched_default_model:env.STAGING_DEFAULT_MODEL};
  if(env.STAGING_PHASE!=='resume')return base;
  return {...base,checkpoint_version:Number(env.STAGING_CHECKPOINT_VERSION),
    checkpoint_ciphertext_sha256:env.STAGING_CHECKPOINT_CIPHERTEXT_SHA};
}
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
    env.GITHUB_RUN_ATTEMPT!=='1'||
    !/^[a-f0-9]{64}$/.test(env.STAGING_DISPATCH_ID??'')||
    !['seed','resume'].includes(env.STAGING_PHASE)||
    !/^qwen[a-z0-9._-]*$/i.test(env.STAGING_DEFAULT_MODEL??'')||
    (env.STAGING_PHASE==='resume'&&!checkpointCommitment(env))))
    fail('staging Worker source identity missing');
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
    task:{id:taskId,type:'develop',issue:stage?2319:ISSUE,target_ref:targetRef,
      ...(stage?stagingTask(env):{})},
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
        !SHA.test(env.STAGING_TARGET_SHA??'')||
        !/^[a-f0-9]{64}$/.test(env.STAGING_DISPATCH_ID??'')||
        !['seed','resume'].includes(env.STAGING_PHASE)||
        !/^qwen[a-z0-9._-]*$/i.test(env.STAGING_DEFAULT_MODEL??'')||
        (env.STAGING_PHASE==='resume'&&!checkpointCommitment(env)))
        : env.GITHUB_EVENT_NAME!=='push')) {
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
function stagingResumeConfig(dir,env){
  let cfg;
  try{cfg=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));}
  catch{fail('missing restored staging Session config');}
  if(cfg?.schema_version!==1||cfg.kind!=='staging-resume-session'||
      !UUID.test(cfg.session_id??'')||
      !/^[a-f0-9]{64}$/.test(cfg.marker_sha256??'')||
      cfg.source_sha!==env.STAGING_TARGET_SHA||
      cfg.model!==providerModel(env)||
      cfg.cli_version!==env.CLAUDE_CODE_VERSION||
      cfg.checkpoint_version!==Number(env.STAGING_CHECKPOINT_VERSION)||
      cfg.ciphertext_sha256!==env.STAGING_CHECKPOINT_CIPHERTEXT_SHA)
    fail('restored staging Session does not match the signed dispatch');
  return cfg;
}
function resumeIdentity(env,cfg,startedAt,finishedAt,envelope,ok){
  const {GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,GITHUB_SHA,GITHUB_REPOSITORY}=env;
  if(!/^[1-9]\d*$/.test(GITHUB_RUN_ID??'')||
      !/^[1-9]\d*$/.test(GITHUB_RUN_ATTEMPT??'')||
      !SHA.test(GITHUB_SHA??'')||GITHUB_REPOSITORY!=='BestNathan/nession'||
      env.GITHUB_WORKFLOW!=='Agent / Staging Developer Canary'||
      env.GITHUB_EVENT_NAME!=='workflow_run'||env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_RUN_ATTEMPT!=='1'||env.STAGING_PHASE!=='resume'||
      !/^[a-f0-9]{64}$/.test(env.STAGING_DISPATCH_ID??'')||
      !checkpointCommitment(env)||
      !/^qwen[a-z0-9._-]*$/i.test(env.STAGING_DEFAULT_MODEL??''))
    fail('staging Worker source identity missing');
  const started=new Date(startedAt).getTime(),ended=new Date(finishedAt).getTime();
  return buildAgentWorkflowTelemetry({
    workflow_id:'agent-staging-developer-canary',
    github_workflow:'Agent / Staging Developer Canary',job:'qwen-developer-canary',
    repository:GITHUB_REPOSITORY,event:'workflow_run',
    github_run_id:Number(GITHUB_RUN_ID),github_run_attempt:Number(GITHUB_RUN_ATTEMPT),
    unique_run_name:providerScopedRunName({workflowId:'agent-staging-developer-canary',
      runId:GITHUB_RUN_ID,runAttempt:GITHUB_RUN_ATTEMPT,
      taskId:'issue-2319-staging-qwen-canary',provider:'claude-code'}),
    task:{id:'issue-2319-staging-qwen-canary',type:'develop',issue:2319,
      target_ref:env.STAGING_TARGET_SHA,...stagingTask(env)},
    agent:{provider:'claude-code',id:'dev-qwen-01',role:'developer',
      model:{id:providerModel(env),request_model:providerModel(env)},
      run_id:envelope?.session_id??cfg.session_id,status:ok?'finished':'error'},
    execution:{turns:envelope?.num_turns??null,model_requests:null,tool_calls:[],
      tools_observed:envelope!==null},
    tokens:normalizeClaudeUsage(envelope),
    cost:{raw_usd:null,charged_usd:null,estimated_usd:null},
    timing:{started_at:startedAt,finished_at:finishedAt,agent_duration_ms:ended-started},
    result:{status:ok?'staging-resume-pass':'staging-resume-error'},
  });
}
// Resume the exact stored native Session in a distinct GitHub Run. The model
// executor receives only the restored config directory and the marker hash;
// Store keys and the commitment stay in the trusted pre-model job.
async function runStagingResume(dir,metricsDir){
  const env=process.env,model=providerModel(env);
  if(!dir||!path.isAbsolute(dir))fail('restored Session directory must be absolute');
  const cfg=stagingResumeConfig(dir,env);
  qwenGatewayEndpoint(env);
  const startedAt=new Date().toISOString();
  let envelope=null,error=null,ok=false;
  try {
    const result=runClaudeCli({prompt:RESUME_PROMPT,model,maxTurns:3,
      allowedTools:'',disallowedTools:'*',cwd:env.GITHUB_WORKSPACE,env:{},
      configDir:path.join(dir,'native'),restricted:true,tools:'',
      resumeSessionId:cfg.session_id});
    if(result.proc.status!==0||result.parsed?.is_error===true)
      fail('restricted Claude Code resume failed (no raw output logged)');
    if(result.parsed?.session_id!==cfg.session_id)
      fail('resumed provider did not keep the stored Session UUID');
    envelope=result.parsed;
    const answer=String(envelope.result??'').trim();
    if(!/^[a-f0-9]{32}$/.test(answer)||
        createHash('sha256').update(answer).digest('hex')!==cfg.marker_sha256)
      fail('stored native Session context was not retained');
    ok=true;
    console.log('Staging resume: stored native Session retained its prior-turn marker');
  }catch(e){error=e;console.error(e.message);}
  finally{
    fs.mkdirSync(metricsDir,{recursive:true});
    const finishedAt=new Date().toISOString();
    const summary=resumeIdentity(env,cfg,startedAt,finishedAt,envelope,ok);
    writeAgentWorkflowTelemetry(path.join(metricsDir,'agent-telemetry.json'),summary);
    const trace=normalizeNativeTrace('claude-code',[],summary,{
      model:'unobserved',tools:'unobserved',skills:'unobserved',mcp:'unobserved',
    });
    writeExecutionTrace(path.join(metricsDir,'agent-execution-trace.json'),trace);
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
    STAGING_TARGET_SHA:'a'.repeat(40),STAGING_DISPATCH_ID:'c'.repeat(64),
    STAGING_PHASE:'resume',STAGING_DEFAULT_MODEL:'qwen3.7-max',
    STAGING_CHECKPOINT_VERSION:'1',STAGING_CHECKPOINT_CIPHERTEXT_SHA:'d'.repeat(64),
    CLAUDE_CODE_VERSION:'2.1.312',ANTHROPIC_MODEL:'qwen3.7-plus',
  };
  const stageRecord=canaryIdentity(stageEnv,'2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:01.000Z',{num_turns:2,session_id:'synthetic'},[],
    {edit_verified:true},{stage:true});
  assert.equal(stageRecord.identity.workflow_id,'agent-staging-developer-canary');
  assert.equal(stageRecord.task.target_ref,stageEnv.STAGING_TARGET_SHA);
  assert.equal(stageRecord.task.dispatch_id,stageEnv.STAGING_DISPATCH_ID);
  assert.equal(stageRecord.task.phase,'resume');
  assert.equal(stageRecord.task.dispatched_default_model,'qwen3.7-max');
  assert.equal(stageRecord.task.checkpoint_version,1);
  assert.equal(stageRecord.task.checkpoint_ciphertext_sha256,
    stageEnv.STAGING_CHECKPOINT_CIPHERTEXT_SHA);
  assert.equal(stageRecord.agent.model.id,'qwen3.7-plus');
  assert.equal(stageRecord.result.status,'staging-canary-pass');
  // A resume without the exact signed checkpoint commitment fails closed.
  for(const missing of [{STAGING_CHECKPOINT_VERSION:''},
    {STAGING_CHECKPOINT_CIPHERTEXT_SHA:''},
    {STAGING_CHECKPOINT_VERSION:'0'},
    {STAGING_CHECKPOINT_CIPHERTEXT_SHA:'0'.repeat(63)}]) {
    assert.throws(()=>canaryIdentity({...stageEnv,...missing},
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',{},[],
      {edit_verified:true},{stage:true}),/staging Worker source/);
  }
  // A seed Run has no checkpoint to commit; it neither requires nor records one.
  const seedRecord=canaryIdentity({...stageEnv,STAGING_PHASE:'seed',
    STAGING_CHECKPOINT_VERSION:'',STAGING_CHECKPOINT_CIPHERTEXT_SHA:''},
    '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',{},[],
    {edit_verified:true},{stage:true});
  assert.equal(seedRecord.task.phase,'seed');
  assert.equal(Object.hasOwn(seedRecord.task,'checkpoint_version'),false);
  assert.equal(Object.hasOwn(seedRecord.task,'checkpoint_ciphertext_sha256'),false);
  // The restored Session config must match the signed dispatch exactly.
  const resumeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-resume-config-'));
  try {
    const cfg={schema_version:1,kind:'staging-resume-session',
      session_id:'11111111-1111-4111-8111-111111111111',
      marker_sha256:'e'.repeat(64),source_sha:stageEnv.STAGING_TARGET_SHA,
      model:'qwen3.7-plus',cli_version:'2.1.312',checkpoint_version:1,
      ciphertext_sha256:stageEnv.STAGING_CHECKPOINT_CIPHERTEXT_SHA,
      checkpoint_commit_sha:'f'.repeat(40),seed_run_id:401,seed_attempt:1};
    fs.writeFileSync(path.join(resumeRoot,'config.json'),JSON.stringify(cfg));
    assert.equal(stagingResumeConfig(resumeRoot,stageEnv).session_id,cfg.session_id);
    for(const change of [
      {source_sha:'0'.repeat(40)},{model:'qwen3.7-max'},{cli_version:'2.1.313'},
      {checkpoint_version:2},{ciphertext_sha256:'0'.repeat(64)},
      {session_id:'not-a-uuid'},{marker_sha256:'short'},
    ]) {
      fs.writeFileSync(path.join(resumeRoot,'config.json'),
        JSON.stringify({...cfg,...change}));
      assert.throws(()=>stagingResumeConfig(resumeRoot,stageEnv),
        /restored staging Session/);
    }
  } finally {fs.rmSync(resumeRoot,{recursive:true,force:true});}
  assert.throws(()=>canaryIdentity({...stageEnv,STAGING_PHASE:'unknown'},
    '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',{},[],
    {edit_verified:true},{stage:true}),/staging Worker source/);
  assert.throws(()=>canaryIdentity({...stageEnv,STAGING_DEFAULT_MODEL:'claude-sonnet-5'},
    '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z',{},[],
    {edit_verified:true},{stage:true}),/staging Worker source/);
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
    process.argv[2]==='staging-resume'?runStagingResume(process.argv[3],process.argv[4]):
    Promise.reject(Error('usage: self-test | run METRICS_DIR | staging METRICS_DIR | '+
      'staging-resume SESSION_DIR METRICS_DIR')))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
