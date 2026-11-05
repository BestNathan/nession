#!/usr/bin/env node
// #2274: unprivileged production Qwen Developer. The signed Store Admission
// was verified independently BEFORE this container started. The model gets
// no GitHub, Store, Controller, Publisher or checkpoint private credentials.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createPublicKey,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {claudeCliToolPolicy} from '../harness/native.mjs';
import {parseNativeEvents,toolUseNames} from '../providers/claude-stream.mjs';
import {normalizeClaudeUsage} from '../providers/claude-code.mjs';
import {prepareQwenTrackedSource,collectQwenDevelopmentPatch}
  from './qwen-development-source.mjs';
import {sealQwenDevelopmentProposal,assertQwenModelHasNoStoreAuthority}
  from './qwen-development-evidence.mjs';
import {verifyQwenNativeContinuation}
  from './qwen-developer-policy.mjs';
import {providerScopedRunName} from '../telemetry/run-name.mjs';
import {buildAgentWorkflowTelemetry,writeAgentWorkflowTelemetry}
  from '../../../agent-workflow-telemetry.mjs';

const SHA=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTEXT=96*1024;
function fail(x){throw Error('isolated Qwen Developer: '+x);}
function read(file,max){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>max||st.size<1)
    fail('missing or unsafe verified file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function put(dir,name,doc){
  fs.writeFileSync(path.join(dir,name),JSON.stringify(doc)+'\n',
    {flag:'wx',mode:0o600});
}
export function qwenWorkerAuthority(admission,env){
  if(admission?.authorized!==true||admission.role!=='developer'||
      admission.agent_id!=='dev-qwen-01'||
      admission.provider!=='claude-code'||
      admission.environment!=='dev-claude-qwen'||
      !['implement','repair'].includes(admission.task)||
      !SHA.test(admission.input_sha??'')||
      !Number.isSafeInteger(admission.issue)||admission.issue<1||
      !Number.isSafeInteger(admission.run_id)||admission.run_id<1||
      env.GITHUB_ACTIONS!=='true'||
      env.GITHUB_REPOSITORY!=='BestNathan/nession'||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      env.GITHUB_WORKFLOW!=='Agent / Development'||
      env.GITHUB_ACTOR!=='github-actions[bot]'||
      env.GITHUB_RUN_ATTEMPT!=='1'||
      Number(env.GITHUB_RUN_ID)!==admission.run_id||
      !SHA.test(env.GITHUB_SHA??'')||
      env.NESSION_DEVELOPER_ISOLATED!=='docker-v1'||
      env.GITHUB_WORKSPACE!=='/workspace'||
      env.RUNNER_TEMP!=='/tmp')
    fail('Qwen execution requires exact authenticated isolated Store Run');
  assertQwenModelHasNoStoreAuthority(env);
  return admission;
}
export function qwenDeveloperPrompt(issue,admission){
  if(issue?.number!==admission?.issue||issue.state!=='open'||
      issue.pull_request||typeof issue.title!=='string'||
      typeof issue.body!=='string'||issue.title.length>320||
      Buffer.byteLength(issue.body)>MAX_CONTEXT)
    fail('Issue context not in bounded authenticated source');
  const guide='You are editing a disposable exact-SHA checkout. '+
    'Use ONLY native Read/Edit/Write tools; no Bash, shell, MCP, skills, network or Git actions. '+
    'Read relevant tracked source files; modify no more than eight existing regular app/source/doc files. '+
    'Do not create/remove/rename files, modify .github, gates, automation, dotfiles, AGENTS.md, VISION.md or PRINCIPLE.md. '+
    'Do not run tests or execute source code. Provide a concise outcome; no PR or publication.';
  return guide+'\nIssue #'+issue.number+': '+issue.title+'\n'+
    issue.body+'\nThe trusted Publisher will validate any proposed patch independently.';
}
function version(){
  let output;
  try{output=execFileSync('claude',['--version'],{
    encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();}
  catch{fail('pinned native Claude CLI missing');}
  const match=/^(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/.exec(output);
  if(!match||match[1]!==process.env.CLAUDE_CODE_VERSION)
    fail('Claude CLI version differs from selected Environment pin');
  return match[1];
}
function nativeMode(admission,plan){
  const directory='/tmp/qwen-native';
  if(fs.existsSync(directory))fail('native Session root already occupied');
  const resuming=Object.hasOwn(admission,'resume_from');
  if(!resuming){
    if(fs.existsSync('/resume')&&fs.readdirSync('/resume').length)
      fail('initial Qwen Session cannot receive native bytes');
    return {configDir:directory,sessionId:randomUUID(),resuming:false};
  }
  const proof=read('/resume/manifest.json',8192);
  if(proof?.schema_version!==1||proof.kind!=='trusted-qwen-native-transfer'||
      proof.recipient_run_id!==admission.run_id||
      proof.action_id!==admission.action_id||
      JSON.stringify(proof.continuation)!==
        JSON.stringify(admission.resume_from))
    fail('unbound native transfer, action or checkpoint');
  const compatible=verifyQwenNativeContinuation(
    admission,plan,proof.metadata);
  const source='/resume/native';
  if(!fs.lstatSync(source).isDirectory()||
      fs.lstatSync(source).isSymbolicLink())
    fail('untrusted pre-model native destination');
  fs.cpSync(source,directory,{recursive:true,force:false,
    errorOnExist:true,dereference:false});
  return {configDir:directory,sessionId:compatible.session_id,resuming:true};
}
function cliCall({prompt,sessionId,resuming,plan,configDir}){
  const argv=['-p',prompt,'--output-format','stream-json','--verbose',
    '--max-turns','10','--model',plan.model,'--strict-mcp-config',
    ...claudeCliToolPolicy(plan.tools,{restricted:true}),
    ...(resuming?['--resume',sessionId]:['--session-id',sessionId])];
  const cliEnv={...process.env,CLAUDE_CONFIG_DIR:configDir,
    DISABLE_AUTOUPDATER:'1',ANTHROPIC_MODEL:plan.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL:plan.model};
  if(cliEnv.CLAUDE_CODE_SKIP_PROMPT_HISTORY==='1')
    fail('native Session persistence cannot be disabled');
  const started=Date.now();
  const proc=spawnSync('claude',argv,{cwd:'/workspace',env:cliEnv,
    encoding:'utf8',timeout:8*60*1000,maxBuffer:8*1024*1024,
    stdio:['ignore','pipe','pipe']});
  if(proc.error||proc.status!==0)fail('Qwen CLI failed; raw model output withheld');
  const {events,envelope}=parseNativeEvents(proc.stdout);
  if(envelope.is_error===true||envelope.session_id!==sessionId)
    fail('Qwen failed to preserve exact native Session ID');
  return {events,envelope,started};
}
function telemetry({admission,plan,events,envelope,started,finished,status}){
  const names=toolUseNames(events);
  return buildAgentWorkflowTelemetry({
    workflow_id:'agent-develop',github_workflow:'Agent / Development',
    job:'qwen-developer',repository:'BestNathan/nession',
    event:'workflow_dispatch',github_run_id:admission.run_id,
    github_run_attempt:1,
    unique_run_name:providerScopedRunName({workflowId:'agent-develop',
      runId:admission.run_id,runAttempt:1,
      taskId:'issue-'+admission.issue+'-'+admission.action_id,
      provider:'claude-code'}),
    task:{id:admission.action_id,type:'develop',issue:admission.issue,
      target_ref:plan.source_sha},
    agent:{provider:'claude-code',id:'dev-qwen-01',role:'developer',
      model:{id:plan.model,request_model:plan.model},
      run_id:envelope?.session_id??null,status},
    execution:{turns:envelope?.num_turns??null,model_requests:null,
      tool_calls:names,tools_observed:events.length>0},
    tokens:normalizeClaudeUsage(envelope),
    cost:{raw_usd:null,charged_usd:null,estimated_usd:null},
    timing:{started_at:new Date(started).toISOString(),
      finished_at:new Date(finished).toISOString(),
      agent_duration_ms:finished-started},
    result:{status:status==='finished'?'proposed_not_published':'error'},
  });
}
async function main(){
  if(process.argv.length!==4)fail('usage: ADMISSION_JSON OUTPUT_DIRECTORY');
  if(!fs.existsSync('/.dockerenv'))fail('Docker isolation mandatory');
  const admission=read(process.argv[2],8192);
  qwenWorkerAuthority(admission,process.env);
  const registry=read('/trusted-code/automation/agents/registry.json',8192);
  const cliVersion=version();
  const snapshot=prepareQwenTrackedSource({admission,registry,
    environment:process.env,cliVersion,workspace:'/workspace'});
  const plan=snapshot.plan;
  const {configDir,sessionId,resuming}=nativeMode(admission,plan);
  const issue=read('/context/issue.json',MAX_CONTEXT+8192);
  const prompt=qwenDeveloperPrompt(issue,admission);
  const publicKeyPem=Buffer.from(
    process.env.QWEN_RESUME_PUBLIC_KEY_B64??'','base64').toString('utf8');
  // Missing/misbound public-only Resume configuration must fail BEFORE any
  // model token is spent. Only the trusted ingester holds the private key.
  let rsa;
  try{rsa=createPublicKey(publicKeyPem);}catch{
    fail('configured Qwen public-only native sealing key is invalid');
  }
  if(rsa.asymmetricKeyType!=='rsa'||
      (rsa.asymmetricKeyDetails?.modulusLength??0)<2048)
    fail('configured Qwen native sealing RSA key is unsafe');
  const out=path.resolve(process.argv[3]);
  if(out!=='/output'||!fs.lstatSync(out).isDirectory())
    fail('untrusted output destination');
  let events=[],envelope=null,started=Date.now(),status='error',error=null;
  try{
    const called=cliCall({prompt,sessionId,resuming,plan,configDir});
    ({events,envelope,started}=called);
    const patch=collectQwenDevelopmentPatch(snapshot,{events});
    const {ciphertext,proof,result}=sealQwenDevelopmentProposal({
      admission,snapshot,patch,sessionId,configDir,publicKeyPem,
      runAttempt:1});
    put(out,'ciphertext.json',ciphertext);
    put(out,'proof.json',proof);
    put(out,'result.json',result);
    status='finished';
    console.log('Qwen native Session and exact-SHA bounded patch sealed for trusted Ingest');
  }catch(e){error=e;console.error('::error::'+e.message);}
  finally{
    const summary=telemetry({admission,plan,events,envelope,started,
      finished:Date.now(),status});
    writeAgentWorkflowTelemetry(path.join(out,'agent-telemetry.json'),summary);
    fs.rmSync(configDir,{recursive:true,force:true});
  }
  if(error)throw error;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
