#!/usr/bin/env node
// Live synthetic cross-Run Claude Code native UUID continuity; no repository writes.
// Both agents are tool-free and the only transferred Session bytes are ciphertext.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {runClaudeCli,normalizeClaudeUsage} from './claude-code.mjs';
import {qwenDeveloperModel,qwenGatewayEndpoint} from '../orchestration/qwen-developer-policy.mjs';
import {sealClaudeNativeSession,openClaudeNativeSession,discoverClaudeNativeProject} from './claude-native-store.mjs';
import {sealCheckpoint} from '../store/checkpoint.mjs';
import {publishEncryptedAgentCheckpoint,readCheckpointHeadVersion} from '../store/remote.mjs';
import {buildAgentWorkflowTelemetry,writeAgentWorkflowTelemetry} from '../../../agent-workflow-telemetry.mjs';

const SHA=/^[a-f0-9]{40}$/, HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha=s=>createHash('sha256').update(s).digest('hex');
function fail(s){throw Error('Claude D1 fixture: '+s);}
function read(file) {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>32*1024*1024)fail('unsafe JSON file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function write(file,doc){fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});}
function origin() {
  const id=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  if(process.env.GITHUB_REPOSITORY!=='BestNathan/nession'||
    process.env.GITHUB_REF!=='refs/heads/main'||
    !SHA.test(process.env.GITHUB_SHA??'')||!Number.isSafeInteger(id)||id<1||
    !Number.isSafeInteger(attempt)||attempt<1)fail('untrusted main Run provenance');
  return {source_sha:process.env.GITHUB_SHA,run_id:id,attempt};
}
function version(){
  const data=execFileSync('claude',['--version'],{encoding:'utf8',timeout:15000});
  const match=/^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(data.trim());
  if(!match)fail('unrecognized Claude Code CLI version');
  return match[1];
}
export function qwenNativeResumeModel(env=process.env){
  // Native Resume must follow the same Environment model binding as the
  // Developer Worker. A stale Acceptance alias cannot silently retarget it.
  qwenGatewayEndpoint(env);
  return qwenDeveloperModel(env);
}
const model=()=>qwenNativeResumeModel();
function harness(sourceSha,cliVersion,requestedModel){
  return sha(JSON.stringify({schema_version:1,provider:'claude-code',backend:'qwen',
    source_sha:sourceSha,cli_version:cliVersion,model:requestedModel,
    tools:'',disallowedTools:'*',restricted:true,settingSources:[],
    archive_schema:'claude-native-jsonl-v1'}));
}
function secret(name){
  const encoded=process.env[name];
  if(typeof encoded!=='string'||encoded.length<100)fail('missing native encryption key: '+name);
  return Buffer.from(encoded,'base64').toString('utf8');
}

// #2319: the staging seed runs inside the signed staging canary. It uses the
// staging target SHA and the pinned model from the verified dispatch; the
// model executor holds only the public sealing key.
function stagingOrigin(){
  const id=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  if(process.env.GITHUB_REPOSITORY!=='BestNathan/nession'||
      process.env.GITHUB_REF!=='refs/heads/main'||
      process.env.GITHUB_WORKFLOW!=='Agent / Staging Developer Canary'||
      process.env.GITHUB_EVENT_NAME!=='workflow_run'||
      !SHA.test(process.env.GITHUB_SHA??'')||
      !SHA.test(process.env.STAGING_TARGET_SHA??'')||
      !/^[a-f0-9]{64}$/.test(process.env.STAGING_DISPATCH_ID??'')||
      !Number.isSafeInteger(id)||id<1||attempt!==1)
    fail('untrusted staging seed Run provenance');
  return {source_sha:process.env.STAGING_TARGET_SHA,workflow_sha:process.env.GITHUB_SHA,
    run_id:id,attempt,dispatch_id:process.env.STAGING_DISPATCH_ID};
}
export function stagingSeedMetadata({sourceSha,runId,attempt,sessionId,projectKey,
  cliVersion,model,dispatchId,cwdSha}) {
  if(!SHA.test(sourceSha??'')||!Number.isSafeInteger(runId)||runId<1||attempt!==1||
      !UUID.test(sessionId??'')||typeof projectKey!=='string'||
      !/^[A-Za-z0-9._-]{1,240}$/.test(projectKey)||
      typeof cliVersion!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(cliVersion)||
      !/^qwen[a-z0-9._-]*$/i.test(model??'')||
      !/^[a-f0-9]{64}$/.test(dispatchId??'')||
      !/^[a-f0-9]{64}$/.test(cwdSha??''))
    fail('invalid staging seed metadata');
  return {session_id:sessionId,source_sha:sourceSha,run_id:runId,attempt,
    project_key:projectKey,cwd_sha256:cwdSha,
    cli_version:cliVersion,harness_digest:harness(sourceSha,cliVersion,model),
    model,dispatch_id:dispatchId,issue:2319,agent_id:'dev-qwen-01'};
}
async function stagingSeed(dir){
  const id=stagingOrigin(),cliVersion=version(),requestedModel=model();
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const configDir=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'claude-staging-seed-'));
  const sessionId=randomUUID(),marker=randomBytes(16).toString('hex');
  try {
    run('Remember this private 32-character hexadecimal marker for a later turn: '+
      marker+'. Reply ONLY with ACK and do not repeat the marker.',configDir,sessionId);
    const projectKey=discoverClaudeNativeProject(configDir,sessionId);
    const metadata=stagingSeedMetadata({sourceSha:id.source_sha,runId:id.run_id,
      attempt:id.attempt,sessionId,projectKey,cliVersion,model:requestedModel,
      dispatchId:id.dispatch_id,cwdSha:ctxSha()});
    const sealed=sealClaudeNativeSession({configDir,metadata,
      publicKeyPem:secret('STAGING_CLAUDE_RESUME_PUBLIC_KEY_B64')});
    write(path.join(dir,'ciphertext.json'),sealed);
    write(path.join(dir,'proof.json'),{schema_version:1,
      kind:'staging_developer_checkpoint_seed',metadata,
      marker_sha256:sha(marker),encrypted_sha256:sealed.ciphertext_sha256});
    console.log('Staging checkpoint: sealed native Session for '+id.source_sha+
      ' model '+requestedModel+' dispatch '+id.dispatch_id);
  } finally {fs.rmSync(configDir,{recursive:true,force:true});}
}
function stagingAesKey(){
  const raw=process.env.STAGING_STORE_AES_KEY_B64;
  if(typeof raw!=='string')fail('missing staging Store AES key');
  const key=Buffer.from(raw,'base64');
  if(key.length!==32)fail('staging Store AES key must be 32 bytes');
  return key;
}
async function stagingPublish(input,out){
  const id=stagingOrigin();
  const proof=read(path.join(input,'proof.json'));
  const sealed=read(path.join(input,'ciphertext.json'));
  const m=proof?.metadata;
  if(proof?.schema_version!==1||proof.kind!=='staging_developer_checkpoint_seed'||
      sealed?.schema_version!==1||sealed.kind!=='claude-native-encrypted-snapshot'||
      sealed.ciphertext_sha256!==proof.encrypted_sha256||
      m?.source_sha!==id.source_sha||m?.run_id!==id.run_id||m?.attempt!==id.attempt||
      m?.dispatch_id!==id.dispatch_id||m?.model!==process.env.ANTHROPIC_MODEL||
      m?.cli_version!==process.env.CLAUDE_CODE_VERSION)
    fail('seed proof does not match the staging dispatch/Run');
  const tmp=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'staging-checkpoint-'));
  const key=stagingAesKey();
  try {
    const native=path.join(tmp,'native');
    const opened=openClaudeNativeSession({record:sealed,
      privateKeyPem:secret('STAGING_CLAUDE_RESUME_PRIVATE_KEY_B64'),
      expected:m,configDir:native});
    const projectDir=path.join(native,'projects',opened.project_key);
    const files=[];
    const walk=(dir,prefix)=>{
      for(const name of fs.readdirSync(dir).sort()){
        const absolute=path.join(dir,name),stat=fs.lstatSync(absolute);
        if(stat.isDirectory())walk(absolute,prefix+name+'/');
        else if(name.endsWith('.jsonl'))files.push({path:prefix+name,
          base64:fs.readFileSync(absolute).toString('base64')});
      }
    };
    walk(projectDir,'');
    if(!files.some(file=>file.path===m.session_id+'.jsonl'))
      fail('native bundle lacks the Session transcript');
    const bundle={schema_version:1,kind:'staging-claude-native-bundle',
      session_id:m.session_id,project_key:opened.project_key,model:m.model,
      cli_version:m.cli_version,dispatch_id:m.dispatch_id,
      seed_run_id:m.run_id,seed_attempt:m.attempt,harness_digest:m.harness_digest,
      files};
    const identity={role:'developer',agent_id:'dev-qwen-01',issue:2319};
    // A later staging SHA seeds a new checkpoint; advance the exact committed
    // head instead of re-claiming version 1 forever. The Store CAS still
    // rejects a racing writer.
    const previous=readCheckpointHeadVersion({
      remote:process.env.AGENT_STORE_CONTROLLER_REMOTE,identity});
    const version=previous.version+1;
    const checkpoint=sealCheckpoint(identity,version,
      Buffer.from(JSON.stringify(bundle)),key,{
        provider:'claude-code',session_id:m.session_id,
        source_sha:m.source_sha,harness_digest:m.harness_digest,
      });
    const source={repository:'BestNathan/nession',run_id:id.run_id,attempt:id.attempt,
      issue:2319,workflow_sha:id.workflow_sha,target_sha:id.source_sha,
      head_branch:'main',role:'developer',
      path:'.github/workflows/agent-staging-developer-canary.yml',
      workflow_name:'Agent / Staging Developer Canary',event:'workflow_run',
      agent_id:'dev-qwen-01',task:'implement',environment:'dev-claude-qwen',
      provider:'claude-code'};
    const registry=JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8'));
    const result=publishEncryptedAgentCheckpoint({
      remote:process.env.AGENT_STORE_CONTROLLER_REMOTE,source,sealed:checkpoint,
      registry,key,expectedVersion:previous.version});
    write(out,{schema_version:1,kind:'staging_developer_checkpoint_receipt',
      issue:2319,dispatch_id:m.dispatch_id,target_sha:m.source_sha,
      seed_run_id:m.run_id,seed_attempt:m.attempt,model:m.model,
      cli_version:m.cli_version,checkpoint_version:result.version,
      commit_sha:result.commit_sha,ciphertext_sha256:checkpoint.ciphertext_sha256});
    console.log('Staging checkpoint published at '+result.commit_sha+
      ' version '+result.version);
  } finally {key.fill(0);fs.rmSync(tmp,{recursive:true,force:true});}
}
function ctxSha(){return sha(path.resolve(process.env.GITHUB_WORKSPACE??''));}
function run(prompt,configDir,sessionId,resume=false){
  const x=runClaudeCli({prompt,model:model(),maxTurns:3,
    allowedTools:'',disallowedTools:'*',cwd:process.env.GITHUB_WORKSPACE,
    env:{},configDir,restricted:true,tools:'',
    ...(resume?{resumeSessionId:sessionId}:{sessionId})});
  if(x.proc.status!==0||x.parsed?.is_error===true||
    x.parsed?.session_id!==sessionId)fail('native Claude CLI did not finish with same UUID');
  return x.parsed;
}
function telemetry(folder,envelope,phase,sourceSha){
  const value=buildAgentWorkflowTelemetry({
    workflow_id:phase==='seed'?'agent-claude-resume-seed':'agent-claude-resume-verify',
    github_workflow:process.env.GITHUB_WORKFLOW,
    job:phase,task:{id:'claude-resume-d1',type:'provider-fixture',target_ref:sourceSha},
    agent:{id:'claude-resume-fixture',role:'auditor',provider:'claude-code',
      model:{id:model()},run_id:envelope.session_id,status:'finished'},
    execution:{turns:envelope.num_turns??null,model_requests:null,tool_calls:[],
      tools_observed:false},
    tokens:normalizeClaudeUsage(envelope),
    cost:{raw_usd:null,charged_usd:null,estimated_usd:null},
    timing:{started_at:null,finished_at:null,agent_duration_ms:envelope.duration_ms??null},
    result:{status:phase==='seed'?'native-snapshot-sealed':'verified-resume'},
  });
  writeAgentWorkflowTelemetry(path.join(folder,'agent-telemetry.json'),value);
}
async function seed(dir) {
  const id=origin(),cliVersion=version(),requestedModel=model();
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const configDir=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'claude-native-seed-'));
  const sessionId=randomUUID(),marker=randomBytes(16).toString('hex');
  try {
    const answer=run('Remember this private 32-character hexadecimal marker for a later turn: '+
      marker+'. Reply ONLY with ACK and do not repeat the marker.',configDir,sessionId);
    const projectKey=discoverClaudeNativeProject(configDir,sessionId);
    const metadata={session_id:sessionId,...id,project_key:projectKey,
      cli_version:cliVersion,cwd_sha256:ctxSha(),
      harness_digest:harness(id.source_sha,cliVersion,requestedModel)};
    const sealed=sealClaudeNativeSession({configDir,metadata,
      publicKeyPem:secret('CLAUDE_RESUME_PUBLIC_KEY_B64')});
    write(path.join(dir,'ciphertext.json'),sealed);
    write(path.join(dir,'proof.json'),{schema_version:1,kind:'claude-resume-seed',
      metadata,marker_sha256:sha(marker),encrypted_sha256:sealed.ciphertext_sha256});
    telemetry(dir,answer,'seed',id.source_sha);
  } finally {fs.rmSync(configDir,{recursive:true,force:true});}
}
export function verifyClaudeSeedSource(run,artifacts,id,attempt,sourceSha){
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(attempt)||attempt<1||
    !SHA.test(sourceSha??'')||run?.id!==id||run.run_attempt!==attempt||
    run.name!=='Agent / Claude Resume Seed'||
    run.path!=='.github/workflows/agent-claude-resume-seed.yml'||
    run.repository?.full_name!=='BestNathan/nession'||
    run.head_repository?.full_name!=='BestNathan/nession'||
    run.head_branch!=='main'||run.head_sha!==sourceSha||
    !['workflow_dispatch','push'].includes(run.event)||run.status!=='completed'||
    run.conclusion!=='success')fail('untrusted upstream Claude seed');
  const matches=artifacts?.artifacts?.filter(x=>x.name==='claude-resume-seed-'+id+'-'+attempt);
  if(!Array.isArray(matches)||matches.length!==1||
    matches[0].expired!==false||matches[0].workflow_run?.id!==id||
    matches[0].workflow_run?.head_sha!==sourceSha||
    !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest??'')||
    !Number.isSafeInteger(matches[0].id)||matches[0].id<1)
    fail('untrusted or ambiguous Claude native ciphertext artifact');
  return {artifact_id:matches[0].id,digest:matches[0].digest};
}
function validatedProof(input) {
  const proof=read(path.join(input,'proof.json')),sealed=read(path.join(input,'ciphertext.json'));
  const m=proof?.metadata;
  if(proof?.schema_version!==1||proof.kind!=='claude-resume-seed'||
      !UUID.test(m?.session_id??'')||!HEX.test(proof.marker_sha256??'')||
      !HEX.test(proof.encrypted_sha256??'')||
      sealed.ciphertext_sha256!==proof.encrypted_sha256)
    fail('invalid source proof/envelope');
  if(m.source_sha!==process.env.SOURCE_SHA||
      m.run_id!==Number(process.env.SOURCE_RUN_ID)||
      m.attempt!==Number(process.env.SOURCE_RUN_ATTEMPT))
    fail('checkpoint Run/Attempt/SHA provenance mismatch');
  const cliVersion=version();
  if(m.cwd_sha256!==ctxSha()||m.cli_version!==cliVersion||
      m.harness_digest!==harness(m.source_sha,cliVersion,model()))
    fail('incompatible native workspace/model/CLI/Harness');
  return {proof,sealed,m};
}
function unseal(input,dir) {
  origin();
  const {sealed,m}=validatedProof(input);
  return openClaudeNativeSession({record:sealed,expected:m,
    privateKeyPem:secret('CLAUDE_RESUME_PRIVATE_KEY_B64'),configDir:dir});
}
function resume(input,dir,out) {
  const now=origin(),{proof,m}=validatedProof(input);
  if(now.run_id===m.run_id)fail('same GitHub Run is not cross-Run durability evidence');
  fs.mkdirSync(out,{recursive:true,mode:0o700});
  const envelope=run('From the PREVIOUS conversation, reply ONLY with the exact '+
    '32-character hexadecimal marker you were asked to remember. Do not invent one.',
    dir,m.session_id,true);
  const answer=String(envelope.result??'').trim();
  if(!/^[a-f0-9]{32}$/.test(answer)||sha(answer)!==proof.marker_sha256)
    fail('native Claude session context continuity NOT verified');
  write(path.join(out,'verification.json'),{schema_version:1,kind:'claude-resume-verified',
    seed_run_id:m.run_id,seed_attempt:m.attempt,resumed_run_id:now.run_id,
    resumed_attempt:now.attempt,source_sha:m.source_sha,session_id:m.session_id,
    prior_marker_sha256:proof.marker_sha256,native_resume_verified:true});
  telemetry(out,envelope,'resume',m.source_sha);
  console.log('Claude D1: same native Session retained secret prior-turn context across Runs');
}
const main=async()=>{
  const [cmd,...args]=process.argv.slice(2);
  if(cmd==='seed'&&args.length===1)return seed(args[0]);
  if(cmd==='staging-seed'&&args.length===1)return stagingSeed(args[0]);
  if(cmd==='staging-publish'&&args.length===2)return stagingPublish(...args);
  if(cmd==='verify-source'&&args.length===5)
    return console.log(JSON.stringify(verifyClaudeSeedSource(read(args[0]),read(args[1]),
      Number(args[2]),Number(args[3]),args[4])));
  if(cmd==='unseal'&&args.length===2)return unseal(...args);
  if(cmd==='resume'&&args.length===3)return resume(...args);
  fail('usage: seed OUT | staging-seed OUT | staging-publish INPUT RECEIPT | verify-source RUN ARTIFACTS RUN ATTEMPT SHA | unseal INPUT CONFIG | resume INPUT CONFIG OUT');
};
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
