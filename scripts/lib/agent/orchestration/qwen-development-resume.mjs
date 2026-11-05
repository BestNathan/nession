#!/usr/bin/env node
// #2274: independent trusted pre-model Qwen Session restore. PREPARE holds
// only Store AES authority and produces ciphertext-only transfer; OPEN holds
// only the dedicated Qwen native private key and reconstructs the exact JSONL
// before the unprivileged Docker model process starts.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fetchEncryptedAgentCheckpoint}
  from '../store/remote.mjs';
import {deriveStoreAesKey}
  from './development-checkpoint-key.mjs';
import {bindQwenDeveloper,verifyQwenNativeContinuation}
  from './qwen-developer-policy.mjs';
import {openClaudeNativeSession} from '../providers/claude-native-store.mjs';

const HEX=/^[a-f0-9]{64}$/;
const SHA=/^[a-f0-9]{40}$/;
const hash=s=>createHash('sha256').update(s).digest('hex');
function fail(m){throw Error('trusted Qwen native restore: '+m);}
function read(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||
      stat.size>24*1024*1024)
    fail('unsafe verified native transfer file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function authority(a,env){
  if(a?.authorized!==true||a.role!=='developer'||
      a.agent_id!=='dev-qwen-01'||
      a.provider!=='claude-code'||
      a.environment!=='dev-claude-qwen'||
      !a.resume_from||!['implement','repair'].includes(a.task)||
      !SHA.test(a.input_sha??'')||
      Number(env.GITHUB_RUN_ID)!==a.run_id||
      env.GITHUB_ACTIONS!=='true'||
      env.GITHUB_REPOSITORY!=='BestNathan/nession'||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_WORKFLOW!=='Agent / Development'||
      env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
      env.GITHUB_RUN_ATTEMPT!=='1')
    fail('Qwen restore requires exact same-Run signed Store admission');
  return a;
}
export function validateQwenNativeTransfer(admission,plan,transfer,record){
  const m=transfer?.metadata;
  if(transfer?.schema_version!==1||
      transfer.kind!=='trusted-qwen-native-transfer'||
      transfer.recipient_run_id!==admission.run_id||
      transfer.action_id!==admission.action_id||
      JSON.stringify(transfer.continuation)!==
        JSON.stringify(admission.resume_from)||
      !HEX.test(transfer.ciphertext_sha256??'')||
      record?.kind!=='claude-native-encrypted-snapshot'||
      record.ciphertext_sha256!==transfer.ciphertext_sha256||
      JSON.stringify(record.metadata)!==JSON.stringify(m)||
      m?.cwd_sha256!==hash('/workspace'))
    fail('transfer not bound to original native project and recipient');
  const compatible=verifyQwenNativeContinuation(admission,plan,m);
  return compatible;
}
export function validateQwenStoredNativeBundle(admission,plan,bundle){
  const m=bundle?.metadata;
  if(bundle?.schema_version!==1||bundle.kind!=='qwen-claude-native-envelope'||
      !HEX.test(bundle.patch_sha256??'')||
      !HEX.test(bundle.action_id??'')||
      !Number.isSafeInteger(bundle.run_id)||bundle.run_id<1||
      bundle.attempt!==1||
      bundle.rsa_envelope?.kind!=='claude-native-encrypted-snapshot'||
      JSON.stringify(bundle.rsa_envelope.metadata)!==JSON.stringify(m)||
      m?.run_id!==bundle.run_id||m.attempt!==bundle.attempt||
      m.cwd_sha256!==hash('/workspace'))
    fail('invalid original encrypted native Store bundle');
  return verifyQwenNativeContinuation(admission,plan,m);
}
function plan(a){
  const registry=read('automation/agents/registry.json');
  return bindQwenDeveloper(a,registry,process.env,{
    cliVersion:process.env.CLAUDE_CODE_VERSION});
}
function put(folder,name,obj){
  fs.writeFileSync(path.join(folder,name),JSON.stringify(obj)+'\n',
    {flag:'wx',mode:0o600});
}
function prepare(admissionFile,destination){
  const a=authority(read(admissionFile),process.env),p=plan(a);
  if(!process.env.STORE_WRITER_PRIVATE_KEY||
     !process.env.AGENT_STORE_CONTROLLER_REMOTE?.startsWith(
       'https://x-access-token:'))
    fail('trusted Store checkpoint read credentials missing');
  const c=a.resume_from;
  const source_sha=a.task==='repair'?c.source_sha:p.source_sha;
  const key=deriveStoreAesKey(process.env.STORE_WRITER_PRIVATE_KEY);
  let bytes;
  try {
    const restored=fetchEncryptedAgentCheckpoint({
      remote:process.env.AGENT_STORE_CONTROLLER_REMOTE,
      identity:{role:'developer',agent_id:a.agent_id,issue:a.issue},
      expected:{provider:'claude-code',source_sha,
        harness_digest:p.harness_digest},
      key,commitment:{commit_sha:c.checkpoint_commit_sha,
        version:c.checkpoint_version,
        ciphertext_sha256:c.ciphertext_sha256}});
    bytes=restored.native_bytes;
    const bundle=JSON.parse(bytes.toString('utf8'));
    validateQwenStoredNativeBundle(a,p,bundle);
    if(fs.existsSync(destination))fail('native transfer destination occupied');
    fs.mkdirSync(destination,{mode:0o700});
    const transfer={schema_version:1,kind:'trusted-qwen-native-transfer',
      recipient_run_id:a.run_id,action_id:a.action_id,
      continuation:c,metadata:bundle.metadata,
      ciphertext_sha256:bundle.rsa_envelope.ciphertext_sha256};
    put(destination,'ciphertext.json',bundle.rsa_envelope);
    put(destination,'manifest.json',transfer);
    console.log('Committed Qwen native Session rewrapped for admitted Run; ciphertext-only transfer');
  }finally{key.fill(0);bytes?.fill(0);}
}
function open(admissionFile,transferDir,destination){
  const a=authority(read(admissionFile),process.env),p=plan(a);
  if(process.env.STORE_WRITER_PRIVATE_KEY||process.env.STORE_APP_TOKEN)
    fail('Store writer credential in pre-model native open job');
  const transfer=read(path.join(transferDir,'manifest.json'));
  const record=read(path.join(transferDir,'ciphertext.json'));
  validateQwenNativeTransfer(a,p,transfer,record);
  const privateKeyPem=Buffer.from(
    process.env.QWEN_RESUME_PRIVATE_KEY_B64??'','base64').toString('utf8');
  if(!privateKeyPem.length)fail('Qwen native private key unavailable');
  const opened=openClaudeNativeSession({
    record,privateKeyPem,expected:transfer.metadata,configDir:destination});
  if(opened.session_id!==transfer.metadata.session_id)
    fail('native UUID changed across trusted pre-model restore');
  console.log('Exact native Qwen Session opened before unprivileged model execution');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const [mode,...args]=process.argv.slice(2);
  try{
    if(mode==='prepare'&&args.length===2)prepare(...args);
    else if(mode==='open'&&args.length===3)open(...args);
    else fail('usage: prepare ADMISSION OUTPUT | open ADMISSION TRANSFER DEST');
  }catch(e){console.error('::error::'+e.message);process.exitCode=1;}
}
