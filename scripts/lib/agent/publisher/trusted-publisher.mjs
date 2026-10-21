#!/usr/bin/env node
// Controlled #1997 trusted Publisher orchestration, exclusively executed by
// main-owned, exact owner issue_comment workflow. This process has no model,
// sub-agent, Runner sandbox or untrusted PR checkout. It is the only place
// where source attestation, orphan CAS and a single GitHub write join.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deriveDispatchKey} from '../orchestration/controller-dispatch.mjs';
import {createGitHubRunReader} from '../orchestration/github-dispatch.mjs';
import {preflightAgentPatch} from './patch-preflight.mjs';
import {attestControlled1997PublisherSource} from './source-attestation.mjs';
import {CONTROLLED_1997_POLICY as POLICY} from './controlled-proposal.mjs';
import {commitControlledPublisherIntent} from './store-intent.mjs';
import {assertControlledPublisherAuthority,publishControlledGitHubPR}
  from './github-publish.mjs';

const REPO='BestNathan/nession',HEX40=/^[a-f0-9]{40}$/;
function fail(s){throw Error('trusted Publisher: '+s);}
const hash=b=>createHash('sha256').update(b).digest('hex');
function file(name,max=3*1024*1024){
  if(typeof name!=='string'||!path.isAbsolute(name))fail('invalid private source path');
  const st=fs.lstatSync(name);
  if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>max)
    fail('invalid source file or byte budget');
  return fs.readFileSync(name);
}
function json(name){try{return JSON.parse(file(name).toString('utf8'));}
  catch{fail('malformed source GitHub JSON');}}
function apiClient(token){
  if(typeof token!=='string'||token.length<10||/\s/.test(token))
    fail('missing separately scoped Publisher GitHub token');
  return async(method,endpoint,payload)=>{
    if(!['GET','POST'].includes(method)||typeof endpoint!=='string'||
       !/^[a-z0-9][A-Za-z0-9/?:=&_.%-]*$/.test(endpoint)||
       endpoint.includes('..'))fail('unsafe GitHub API endpoint');
    const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
      method,headers:{
        Authorization:'Bearer '+token,
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'nession-controlled-publisher-main',
        ...(method==='POST'?{'Content-Type':'application/json'}:{}),
      },
      ...(method==='POST'?{body:JSON.stringify(payload)}:{}),
      signal:AbortSignal.timeout(20000),
    });
    if(!response.ok)throw Object.assign(Error(
      'authenticated Publisher GitHub '+method+' '+response.status),{
        status:response.status,
      });
    try{return await response.json();}
    catch{fail('invalid Publisher GitHub JSON response');}
  };
}
export async function runControlledPublication(env,sourceFiles){
  let event;
  try{event=JSON.parse(file(env.GITHUB_EVENT_PATH,128*1024).toString('utf8'));}
  catch{fail('invalid GitHub issue comment event');}
  const context=assertControlledPublisherAuthority(env,event);
  if(!HEX40.test(context.target_main_sha??'')||
     env.GITHUB_SHA!==context.target_main_sha)
    fail('unsigned main source ref');
  const targetCheckout=path.resolve(env.GITHUB_WORKSPACE??'');
  const sourceCheckout=path.resolve(sourceFiles.checkout??'');
  if(!path.isAbsolute(targetCheckout)||!path.isAbsolute(sourceCheckout)||
     sourceCheckout===targetCheckout)
    fail('source and target workspaces must be separately pinned');
  const actionsToken=env.ACTIONS_READ_TOKEN;
  if(!actionsToken||typeof actionsToken!=='string')fail('missing Actions read provenance');
  if(!env.STORE_WRITER_PRIVATE_KEY||!env.STORE_APP_TOKEN||
     !env.PUBLISHER_GITHUB_TOKEN)
    fail('missing separate trusted Store and Publisher authority');
  const sourceRun=json(sourceFiles.worker);
  const ingesterRun=json(sourceFiles.ingest);
  const artifacts=json(sourceFiles.artifacts);
  const claimZip=file(sourceFiles.claimZip,256*1024);
  const resultZip=file(sourceFiles.resultZip,32*1024*1024);
  const key=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  const remote='https://x-access-token:'+env.STORE_APP_TOKEN+
    '@github.com/'+REPO+'.git';
  let prepared;
  try{
    prepared=await attestControlled1997PublisherSource({
      run:sourceRun,ingesterRun,artifacts,claimZip,resultZip,key,
      reader:createGitHubRunReader(actionsToken),
      remote,checkout:sourceCheckout,
    });
  }finally{key.fill(0);}
  // A *second* preflight against the exact current main proves this earlier
  // Developer source patch does not change unrelated files on latest main.
  const target=preflightAgentPatch({
    checkout:targetCheckout,source_sha:context.target_main_sha,
    patch:prepared.patch,
    allowed_paths:[POLICY.file],create_paths:[POLICY.file],
  });
  if(target.files.length!==1||target.files[0].path!==POLICY.file||
     target.files[0].operation!=='create'||
     target.files[0].new_sha256!==hash(Buffer.from(POLICY.content))||
     target.patch_sha256!==prepared.patch_sha256)
    fail('latest main candidate differs from trusted Developer edit');
  // The network source is checked *before* any Store or GitHub write.
  const prApi=apiClient(env.PUBLISHER_GITHUB_TOKEN);
  const remoteHead=await prApi('GET','git/ref/heads/main');
  if(remoteHead.ref!=='refs/heads/main'||
     remoteHead.object?.sha!==context.target_main_sha)
    fail('main moved before immutable publication intent');
  const intent=commitControlledPublisherIntent({
    remote,target_main_sha:context.target_main_sha,
    patch_sha256:prepared.patch_sha256,
    issuer_run_id:context.issuer_run_id,
  });
  if(intent.status!=='committed'||intent.may_publish!==true)
    return {schema_version:1,kind:'trusted_publisher_reconciliation',
      status:'reconcile_no_retry',issue:1997,
      action_id:POLICY.action_id,
      publication_intent_store_sha:intent.store_commit_sha};
  return publishControlledGitHubPR({prepared,intent,api:prApi});
}
async function main(){
  if(process.argv[2]!=='publish'||process.argv.length!==9)
    fail('usage: publish WORKER_JSON INGEST_JSON ARTIFACTS_JSON CLAIM_ZIP RESULT_ZIP SOURCE_CHECKOUT');
  const env=process.env;
  const result=await runControlledPublication(env,{
    worker:process.argv[3],ingest:process.argv[4],
    artifacts:process.argv[5],claimZip:process.argv[6],
    resultZip:process.argv[7],checkout:process.argv[8],
  });
  // Sanitized output only: never emit signed HMAC/Worker native Session files,
  // tokens, Ciphertext, resume key, raw prompt, or untrusted PR metadata.
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
