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
import {sealClaudeNativeSession,openClaudeNativeSession,discoverClaudeNativeProject} from './claude-native-store.mjs';
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
function model(){
  const v=process.env.ACCEPTANCE_CLAUDE_MODEL||process.env.ANTHROPIC_MODEL;
  if(typeof v!=='string'||!/^qwen[a-z0-9._-]*$/i.test(v))
    fail('explicit authorized Qwen model required; no Claude-model substitution');
  return v;
}
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
  if(cmd==='verify-source'&&args.length===5)
    return console.log(JSON.stringify(verifyClaudeSeedSource(read(args[0]),read(args[1]),
      Number(args[2]),Number(args[3]),args[4])));
  if(cmd==='unseal'&&args.length===2)return unseal(...args);
  if(cmd==='resume'&&args.length===3)return resume(...args);
  fail('usage: seed OUT | verify-source RUN ARTIFACTS RUN ATTEMPT SHA | unseal INPUT CONFIG | resume INPUT CONFIG OUT');
};
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
