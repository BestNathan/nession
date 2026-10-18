#!/usr/bin/env node
// D1 only: synthetic tool-free Cursor native continuity across distinct GitHub Runs.
// This is NOT the actual agent-store, a PR Publisher, or a production Agent.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCursorSession } from './cursor.mjs';
import { sealCursorNativeStore, openCursorNativeStore } from './cursor-native-store.mjs';
import { buildAgentWorkflowTelemetry, writeAgentWorkflowTelemetry } from '../../../agent-workflow-telemetry.mjs';

const SHA=/^[a-f0-9]{40}$/, HEX=/^[a-f0-9]{64}$/;
const digest=s=>createHash('sha256').update(s).digest('hex');
function fail(message){throw new Error('Cursor D1 fixture: '+message);}
function readJson(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)fail('unsafe input file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function write(file,doc){fs.writeFileSync(file,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});}
function sdkVersion(){
  const root=process.env.CURSOR_SDK_ROOT;
  if(!root)fail('SDK root missing');
  const v=readJson(path.join(root,'node_modules/@cursor/sdk/package.json')).version;
  if(typeof v!=='string'||!/^[a-zA-Z0-9.+-]{1,80}$/.test(v))fail('invalid SDK version');
  return v;
}
function model(){
  return {id:process.env.CURSOR_MODEL||'composer-2.5',
    fast:String(process.env.CURSOR_MODEL_FAST||'true').toLowerCase()!=='false'};
}
function harnessDigest(sha,version,requestedModel){
  return digest(JSON.stringify({schema_version:1,provider:'cursor',source_sha:sha,
    sdk_version:version,model:requestedModel,tools:[],settingSources:[],checkpoint_format:'jsonl-v1'}));
}
function pem(envName){
  const value=process.env[envName];
  if(typeof value!=='string'||value.length<100)fail('missing checkpoint cryptographic key');
  const result=Buffer.from(value,'base64').toString('utf8');
  if(!result.includes('-----BEGIN')||!result.includes('-----END'))fail('bad key format');
  return result;
}
function identityEnv(){
  const sha=process.env.GITHUB_SHA;
  const runId=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  if(!SHA.test(sha??'')||!Number.isSafeInteger(runId)||runId<=0||
    !Number.isSafeInteger(attempt)||attempt<=0)fail('missing real GitHub source identity');
  if(process.env.GITHUB_REPOSITORY!=='BestNathan/nession'||process.env.GITHUB_REF!=='refs/heads/main')
    fail('fixture source must be trusted main');
  return {sha,runId,attempt};
}
function telemetry(out,meta,sha,phase,verified){
  const input={
    workflow_id:phase==='resume'?'agent-cursor-resume-verify':'agent-cursor-resume-seed',
    github_workflow:process.env.GITHUB_WORKFLOW,
    job:phase, task:{id:'cursor-resume-d1',type:'provider-fixture',target_ref:sha},
    agent:{id:'cursor-resume-fixture',role:'auditor',provider:'cursor',
      model:meta.model,run_id:meta.run_id,status:meta.status},
    execution:{turns:meta.turns,model_requests:meta.turns,tool_calls:meta.tool_calls,
      tools_observed:true},
    tokens:meta.usage,cost:meta.cost,
    timing:{started_at:meta.started_at,finished_at:meta.finished_at,agent_duration_ms:meta.duration_ms},
    result:{status:verified?'verified-resume':'native-snapshot-sealed'},
  };
  writeAgentWorkflowTelemetry(out,buildAgentWorkflowTelemetry(input));
}
async function seed(outdir){
  const {sha,runId,attempt}=identityEnv();
  if(!process.env.CURSOR_API_KEY)fail('Cursor key missing from cursor Environment');
  const version=sdkVersion(),request=model();
  fs.mkdirSync(outdir,{recursive:true,mode:0o700});
  const work=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||outdir,'cursor-seed-'));
  const marker=randomBytes(16).toString('hex');
  const store=path.join(work,'store');
  fs.mkdirSync(store,{mode:0o700});
  try{
    // Only this bounded synthetic memory prompt is allowed. Absolutely no shell / file tools.
    const {result,meta}=await runCursorSession({apiKey:process.env.CURSOR_API_KEY,
      name:'nession-cursor-resume-d1',requestedModel:request,workspace:process.env.GITHUB_WORKSPACE,storePath:store,
      tools:[],prompt:'This is a two-run persistence verification. Remember this private hex marker '+
        'for the next turn: '+marker+'. Respond with ACK only. Do not repeat the marker.'});
    if(result?.status!=='finished'||!/^agent-[a-zA-Z0-9-]{4,100}$/.test(meta.agent_id??''))
      fail('native seed agent did not finish with a persistent local ID');
    const metadata={agent_id:meta.agent_id,source_sha:sha,
      harness_digest:harnessDigest(sha,version,request),run_id:runId,attempt,sdk_version:version};
    const sealed=sealCursorNativeStore({directory:store,metadata,
      publicKeyPem:pem('CURSOR_RESUME_PUBLIC_KEY_B64')});
    write(path.join(outdir,'ciphertext.json'),sealed);
    write(path.join(outdir,'proof.json'),{schema_version:1,kind:'cursor-resume-d1-seed',
      metadata,marker_sha256:digest(marker),encrypted_sha256:sealed.ciphertext_sha256});
    // Telemetry is sanitized and is not itself a native session checkpoint.
    telemetry(path.join(outdir,'agent-telemetry.json'),meta,sha,'seed',false);
  }finally{fs.rmSync(work,{recursive:true,force:true});}
}
function validateProof(proof){
  if(proof?.schema_version!==1||proof.kind!=='cursor-resume-d1-seed'||
    !HEX.test(proof.marker_sha256??'')||!HEX.test(proof.encrypted_sha256??''))
    fail('invalid prior-run proof');
  return proof.metadata;
}
export function verifyCursorSeedSource(run,artifacts,id,attempt,sha) {
  const expectedName='cursor-resume-seed-'+id+'-'+attempt;
  if(run?.id!==id||run.run_attempt!==attempt||run.name!=='Agent / Cursor Resume Seed'||
    run.path!=='.github/workflows/agent-cursor-resume-seed.yml'||
    run.repository?.full_name!=='BestNathan/nession'||
    run.head_repository?.full_name!=='BestNathan/nession'||
    !['push','workflow_dispatch'].includes(run.event)||run.head_branch!=='main'||
    run.head_sha!==sha||run.status!=='completed'||run.conclusion!=='success')
    fail('untrusted seed workflow run identity');
  if(!Array.isArray(artifacts?.artifacts)||artifacts.total_count!==artifacts.artifacts.length)
    fail('incomplete source artifact catalog');
  const exact=artifacts.artifacts.filter(x=>x.name===expectedName);
  if(exact.length!==1||exact[0].expired!==false||
    exact[0].workflow_run?.id!==id||exact[0].workflow_run?.head_sha!==sha||
    !/^sha256:[a-f0-9]{64}$/.test(exact[0].digest??''))
    fail('missing/duplicate/unverified encrypted artifact');
  return exact[0].digest;
}
function unseal(input,destination){
  const proof=readJson(path.join(input,'proof.json')),sealed=readJson(path.join(input,'ciphertext.json'));
  const metadata=validateProof(proof);
  const source=Number(process.env.SOURCE_RUN_ID),attempt=Number(process.env.SOURCE_RUN_ATTEMPT);
  const sha=process.env.SOURCE_SHA;
  if(!Number.isSafeInteger(source)||source<1||!Number.isSafeInteger(attempt)||attempt<1||
    !SHA.test(sha??'')||metadata.run_id!==source||metadata.attempt!==attempt||
    metadata.source_sha!==sha||sealed.ciphertext_sha256!==proof.encrypted_sha256)
    fail('source/Artifact/proof mismatched');
  const version=sdkVersion(),request=model();
  if(metadata.sdk_version!==version||metadata.harness_digest!==harnessDigest(sha,version,request))
    fail('incompatible native Harness or SDK version');
  openCursorNativeStore({record:sealed,expected:metadata,
    privateKeyPem:pem('CURSOR_RESUME_PRIVATE_KEY_B64'),directory:destination});
  // No native bytes are printed or re-uploaded.
}
async function resume(input,store,output){
  const proof=readJson(path.join(input,'proof.json')),meta=validateProof(proof);
  const {runId:currentRunId}=identityEnv(); // Current recipient must be trusted main.
  if(meta.run_id===currentRunId) fail('same GitHub Run cannot prove cross-Run continuity');
  const sha=process.env.SOURCE_SHA;
  if(!SHA.test(sha??'')||meta.source_sha!==sha||meta.sdk_version!==sdkVersion()||
    meta.harness_digest!==harnessDigest(sha,sdkVersion(),model()))
    fail('source/Harness changed during native resume');
  if(!process.env.CURSOR_API_KEY)fail('Cursor key missing');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const {result,meta:executed}=await runCursorSession({apiKey:process.env.CURSOR_API_KEY,
    name:'nession-cursor-resume-d1',requestedModel:model(),workspace:process.env.GITHUB_WORKSPACE,
    storePath:store,resumeAgentId:meta.agent_id,tools:[],
    prompt:'From the PREVIOUS conversation turn, recall the exact private 32-digit hexadecimal '+
      'marker. Reply ONLY those 32 hexadecimal characters. Do not invent a marker.'});
  const answer=String(result?.result??'').trim();
  if(result?.status!=='finished'||executed.resumed!==true||
    executed.agent_id!==meta.agent_id||!/^[a-f0-9]{32}$/.test(answer)||
    digest(answer)!==proof.marker_sha256)fail('real native context continuity NOT established');
  const verdict={schema_version:1,kind:'cursor-resume-d1-verification',
    seed_run_id:meta.run_id,seed_attempt:meta.attempt,
    resumed_run_id:Number(process.env.GITHUB_RUN_ID),
    resumed_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
    source_sha:sha,agent_id:meta.agent_id,native_resume_verified:true,
    prior_context_marker_sha256:proof.marker_sha256};
  write(path.join(output,'verification.json'),verdict);
  telemetry(path.join(output,'agent-telemetry.json'),executed,sha,'resume',true);
  console.log('Cursor D1: independently resumed native SDK Agent context across GitHub Runs');
}
async function main(){
  const [action,...args]=process.argv.slice(2);
  if(action==='seed'&&args.length===1)return seed(args[0]);
  if(action==='verify-source'&&args.length===5){
    const [run,artifacts,id,attempt,sha]=args;
    return console.log(verifyCursorSeedSource(readJson(run),readJson(artifacts),Number(id),Number(attempt),sha));
  }
  if(action==='unseal'&&args.length===2)return unseal(...args);
  if(action==='resume'&&args.length===3)return resume(...args);
  fail('usage: seed OUT | verify-source RUN_JSON ARTIFACTS_JSON RUN ATTEMPT SHA | unseal INPUT STORE | resume INPUT STORE OUT');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
