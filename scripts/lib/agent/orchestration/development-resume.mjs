#!/usr/bin/env node
// Trusted pre-model native restore. Store key use is confined to the separate
// restore job; only an RSA-sealed transport crosses into the Developer job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveIdentity,resolveProviderPlan} from '../harness/contract.mjs';
import {fetchEncryptedAgentCheckpoint} from '../store/remote.mjs';
import {sealCursorNativeStore,openCursorNativeStore} from '../providers/cursor-native-store.mjs';
import {deriveStoreAesKey} from './development-checkpoint-key.mjs';
import {nativeResumeSuccessorId} from './outbox.mjs';

export const CONTROLLED_CONTINUATION='3f4abb86785d41dbb771edbab1c400841d3d0e60335358332307b75e1d36c1c8';
export const CONTROLLED_CONTINUATION_COMMENT='/nession resume issue=1997 checkpoint=1';
const SOURCE='220266b9233ec97b1beacbc54e5cc7f82d3cece2';
const COMMIT='d812e3655c0ad6337b1003aa0c1794c12335adb0';
const CIPHERTEXT='a42220e24ed5ff587ed6173b662a75856f62e5a16561274cb616325b150f4107';
const PARENT='85b69a9de06b02eb78f8a3a15d14b58a43ffc83ee6b1f5db11b9b541cfec9656';
const FILES=['agents.ndjson','checkpoints.ndjson','runs.ndjson','run_events.ndjson'];
const hash=b=>createHash('sha256').update(b).digest('hex');
function fail(s){throw Error('trusted Developer native restore: '+s);}
export function developmentHarnessDigest(source,sdkVersion,model){
  return hash(JSON.stringify({schema_version:1,provider:'cursor',source_sha:source,
    sdk_version:sdkVersion,model,tools:['read','grep','edit'],settingSources:[],
    checkpoint_format:'jsonl-v1'}));
}
export function assertControlledContinuation(a) {
  const c=a?.resume_from;
  if(a?.authorized!==true||a.issue!==1997||a.role!=='developer'||
    a.agent_id!=='dev-cursor-01'||a.task!=='implement'||a.provider!=='cursor'||
    ![CONTROLLED_CONTINUATION,nativeResumeSuccessorId(1997,CONTROLLED_CONTINUATION,39376331942)]
      .includes(a.action_id)||a.input_sha!==SOURCE||
    !c||Object.keys(c).sort().join(',')!==
      'checkpoint_commit_sha,checkpoint_version,ciphertext_sha256,ordinal,parent_action_id'||
    c.ordinal!==1||c.parent_action_id!==PARENT||c.checkpoint_version!==1||
    c.checkpoint_commit_sha!==COMMIT||c.ciphertext_sha256!==CIPHERTEXT)
    fail('only the committed controlled #1997 continuation is enabled');
  return c;
}
export function assertCurrentDevelopmentCapabilities(a,registry){
  const identity=resolveIdentity(registry,a.agent_id,a.task,a.environment);
  const plan=resolveProviderPlan(registry,identity,[]);
  if(identity.role!=='developer'||identity.provider!=='cursor'||
    !['read','grep','edit'].every(name=>plan.native_tools.some(tool=>tool.native_name===name))||
    !plan.canonical_capabilities.tools.includes('github.issue.read'))
    fail('required native Tool or Issue-read permission was revoked');
}
function readJson(file,max=32*1024*1024){
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size>max)fail('unsafe input JSON');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
// Preserve complete Provider-native files, never rebuild a conversation.
export function writeNativeBundle(bytes,directory){
  if(!Buffer.isBuffer(bytes)||bytes.length>16*1024*1024)fail('unsafe native bytes');
  const doc=JSON.parse(bytes.toString('utf8'));
  if(doc.schema_version!==1||doc.kind!=='cursor-native-files'||
    Object.keys(doc).sort().join(',')!=='files,kind,schema_version'||
    Object.keys(doc.files??{}).sort().join(',')!==[...FILES].sort().join(','))
    fail('invalid native checkpoint bundle');
  const buffers=FILES.map(name=>{
    const value=doc.files[name];
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('bad native file encoding');
    const b=Buffer.from(value,'base64');
    if(b.toString('base64')!==value||b.length>16*1024*1024)fail('noncanonical native file');
    for(const line of b.toString('utf8').split(/\r?\n/).filter(Boolean))JSON.parse(line);
    return b;
  });
  if(!buffers[1].length||buffers.reduce((n,b)=>n+b.length,0)>16*1024*1024)
    fail('empty or unbounded native conversation');
  if(fs.existsSync(directory))fail('native restore destination must be new');
  const st=fs.lstatSync(path.dirname(directory));
  if(!st.isDirectory()||st.isSymbolicLink())fail('unsafe native parent');
  fs.mkdirSync(directory,{mode:0o700});
  FILES.forEach((name,i)=>fs.writeFileSync(path.join(directory,name),buffers[i],{flag:'wx',mode:0o600}));
}
function parameters(){
  const version=process.env.CURSOR_SDK_VERSION||'1.0.37';
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))fail('pinned SDK required');
  const model={id:process.env.CURSOR_MODEL||'composer-2.5',fast:(process.env.CURSOR_MODEL_FAST||'true')!=='false'};
  return {version,model,digest:developmentHarnessDigest(SOURCE,version,model)};
}
function authority(){
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='BestNathan/nession'||
    process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_WORKFLOW!=='Agent / Development'||
    process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||
    Number(process.env.GITHUB_RUN_ATTEMPT)!==1)fail('trusted main Developer authority required');
}
async function prepare(admissionFile,out){
  authority();
  const a=readJson(admissionFile,8192),c=assertControlledContinuation(a);
  assertCurrentDevelopmentCapabilities(a,JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8')));
  if(a.run_id!==Number(process.env.GITHUB_RUN_ID))fail('wrong restore recipient Run');
  const {version,digest}=parameters();
  const key=deriveStoreAesKey(process.env.STORE_WRITER_PRIVATE_KEY);
  let native;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'trusted-native-transfer-'));
  try{
    const restored=fetchEncryptedAgentCheckpoint({remote:'https://github.com/BestNathan/nession.git',
      identity:{role:a.role,agent_id:a.agent_id,issue:a.issue},key,
      expected:{provider:'cursor',source_sha:SOURCE,harness_digest:digest},
      commitment:{commit_sha:c.checkpoint_commit_sha,version:c.checkpoint_version,ciphertext_sha256:c.ciphertext_sha256}});
    native=restored.native_bytes;
    // Controlled v1 source is the separately verified immutable Worker Run.
    const meta={agent_id:'agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6',
      source_sha:SOURCE,harness_digest:digest,run_id:39288961865,attempt:1,sdk_version:version};
    const dir=path.join(root,'native');
    writeNativeBundle(native,dir);
    const privateKey=createPrivateKey(Buffer.from(process.env.CURSOR_RESUME_PRIVATE_KEY_B64||'','base64').toString('utf8'));
    const publicPem=createPublicKey(privateKey).export({format:'pem',type:'spki'});
    const sealed=sealCursorNativeStore({directory:dir,metadata:meta,publicKeyPem:publicPem});
    fs.mkdirSync(out,{mode:0o700});
    fs.writeFileSync(path.join(out,'ciphertext.json'),JSON.stringify(sealed)+'\n',{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(out,'resume.json'),JSON.stringify({schema_version:1,
      kind:'trusted-development-native-transfer',recipient_run_id:a.run_id,
      action_id:a.action_id,continuation:c,metadata:meta,
      ciphertext_sha256:sealed.ciphertext_sha256})+'\n',{flag:'wx',mode:0o600});
    console.log('Committed encrypted native Session rewrapped for the exact admitted recipient; no model executed');
  }finally{key.fill(0);native?.fill(0);fs.rmSync(root,{recursive:true,force:true});}
}
function open(admissionFile,input,destination){
  authority();
  if(process.env.STORE_WRITER_PRIVATE_KEY||process.env.STORE_APP_TOKEN)
    fail('Store writer key must remain in separate restore job');
  const a=readJson(admissionFile,8192),c=assertControlledContinuation(a);
  assertCurrentDevelopmentCapabilities(a,JSON.parse(fs.readFileSync('automation/agents/registry.json','utf8')));
  const proof=readJson(path.join(input,'resume.json'),8192);
  const sealed=readJson(path.join(input,'ciphertext.json'));
  const {version,digest}=parameters();
  if(proof.schema_version!==1||proof.kind!=='trusted-development-native-transfer'||
    proof.recipient_run_id!==a.run_id||a.run_id!==Number(process.env.GITHUB_RUN_ID)||
    proof.action_id!==a.action_id||JSON.stringify(proof.continuation)!==JSON.stringify(c)||
    proof.metadata?.sdk_version!==version||proof.metadata.harness_digest!==digest||
    proof.metadata.agent_id!=='agent-7d5b4a61-1476-4ce7-a38a-82907aa3b1a6'||
    proof.metadata.run_id!==39288961865||proof.metadata.attempt!==1||
    proof.metadata.source_sha!==SOURCE||proof.ciphertext_sha256!==sealed.ciphertext_sha256)
    fail('native transfer source/recipient/Harness mismatch');
  openCursorNativeStore({record:sealed,expected:proof.metadata,
    privateKeyPem:Buffer.from(process.env.CURSOR_RESUME_PRIVATE_KEY_B64||'','base64').toString('utf8'),
    directory:destination});
  console.log('Native Session restored before model execution; no private key enters Docker');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const [mode,...args]=process.argv.slice(2);
  if(mode==='prepare'&&args.length===2)prepare(...args).catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
  else if(mode==='open'&&args.length===3)try{open(...args);}catch(e){console.error('::error::'+e.message);process.exitCode=1;}
  else {console.error('usage: prepare ADMISSION OUTPUT | open ADMISSION INPUT NATIVE_DIRECTORY');process.exitCode=1;}
}
