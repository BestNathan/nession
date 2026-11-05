#!/usr/bin/env node
// #2274: main-owned, credential-separated Qwen Publisher. This never calls a
// model and never executes Worker/source/PR checkout code. It authenticates
// the completed Store Ingest, original Worker and BOTH original ZIPs against
// GitHub + the signed Outbox, then Store CAS-fences one GitHub PR publication.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createGitHubRunReader}
  from '../orchestration/github-dispatch.mjs';
import {authenticateWorkerClaimRun,inspectWorkerClaimZip}
  from '../orchestration/worker-reconcile.mjs';
import {readWorkerZipMember}
  from '../orchestration/worker-zip.mjs';
import {deriveDispatchKey}
  from '../orchestration/controller-dispatch.mjs';
import {preflightTrustedQwenPublisher}
  from './qwen-source-preflight.mjs';
import {commitQwenPublisherIntent}
  from './store-intent.mjs';
import {publishTrustedQwenGitHubPR,readBackQwenPublishedPR}
  from './qwen-github-publish.mjs';
import {applyQwenPublicationToRemote}
  from './publication-ingest.mjs';

const REPO='BestNathan/nession',SHA=/^[a-f0-9]{40}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
function fail(m){throw Error('trusted Qwen Publisher Runner: '+m);}
const sha256=b=>createHash('sha256').update(b).digest('hex');
const positive=x=>Number.isSafeInteger(x)&&x>0;
function jsonFile(file,max=32*1024*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max||stat.size<1)
    fail('unsafe trusted source file');
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(
    fs.readFileSync(file)));}
  catch{fail('invalid trusted source JSON');}
}
function zipJson(zip,name){
  try{return JSON.parse(new TextDecoder('utf8',{fatal:true})
    .decode(readWorkerZipMember(zip,name)));}
  catch{fail('unsafe original Worker ZIP member '+name);}
}
function zipVerified(file,artifact,max){
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||!positive(st.size)||
      st.size>max||st.size!==artifact.size_in_bytes||
      !DIGEST.test(artifact.digest??''))
    fail('original Worker ZIP exceeds authenticated byte budget');
  const bytes=fs.readFileSync(file);
  if('sha256:'+sha256(bytes)!==artifact.digest)
    fail('original GitHub Artifact digest mismatch');
  return bytes;
}
function artifactFor(artifacts,run,name,max){
  if(artifacts?.total_count!==artifacts?.artifacts?.length||
      artifacts.total_count>100)
    fail('incomplete paginated GitHub Worker Artifact list');
  const matched=artifacts.artifacts.filter(x=>x.name===name);
  if(matched.length!==1||matched[0].expired!==false||
      matched[0].workflow_run?.id!==run.id||
      matched[0].workflow_run?.head_sha!==run.head_sha||
      !positive(matched[0].id)||!positive(matched[0].size_in_bytes)||
      matched[0].size_in_bytes>max||
      !DIGEST.test(matched[0].digest??''))
    fail('missing, duplicate, expired or impersonated Worker Artifact');
  return matched[0];
}
export function assertQwenPublisherRunAuthority(env,event,ingester,receipt){
  if(env?.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_EVENT_NAME!=='workflow_run'||
      env.GITHUB_WORKFLOW!=='Store / Qwen Publisher'||
      env.GITHUB_RUN_ATTEMPT!=='1'||
      !positive(Number(env.GITHUB_RUN_ID))||
      !SHA.test(env.GITHUB_SHA??'')||
      event?.action!=='completed'||
      event.workflow_run?.id!==ingester?.id||
      event.workflow_run?.head_sha!==ingester.head_sha||
      event.workflow_run?.conclusion!=='success'||
      ingester.status!=='completed'||ingester.conclusion!=='success'||
      ingester.event!=='workflow_run'||ingester.run_attempt!==1||
      ingester.path!=='.github/workflows/store-agent-development-ingest.yml'||
      ingester.name!=='Store / Agent Development Ingest'||
      ingester.head_branch!=='main'||
      ingester.repository?.full_name!==REPO||
      ingester.head_repository?.full_name!==REPO||
      !SHA.test(ingester.head_sha??'')||
      receipt?.schema_version!==1||
      receipt.kind!=='authenticated_qwen_development_checkpoint_receipt'||
      !['committed','replayed'].includes(receipt.status)||
      receipt.ingester_run_id!==ingester.id||
      receipt.ingester_sha!==ingester.head_sha||
      !positive(receipt.run_id)||receipt.attempt!==1||
      !SHA.test(receipt.worker_sha??'')||
      !positive(receipt.issue)||
      !/^[a-f0-9]{64}$/.test(receipt.action_id??'')||
      !positive(receipt.checkpoint_version)||
      !SHA.test(receipt.checkpoint_commit_sha??'')||
      !/^[a-f0-9]{64}$/.test(receipt.ciphertext_sha256??''))
    fail('Publisher source was not a main-owned completed Qwen Store Ingest');
  return {source_run_id:receipt.run_id,issue:receipt.issue,
    action_id:receipt.action_id};
}
function apiClient(token){
  if(typeof token!=='string'||token.length<12||/\s/.test(token))
    fail('separately scoped Publisher GitHub App token missing');
  return async(method,endpoint,payload)=>{
    if(!['GET','POST'].includes(method)||typeof endpoint!=='string'||
        !/^[a-z0-9][A-Za-z0-9/?:=&_.%+-]*$/.test(endpoint)||
        endpoint.includes('..')||
        (method==='POST'&&!/^(?:git\/(?:blobs|trees|commits|refs)|pulls)$/.test(endpoint)))
      fail('unapproved Publisher GitHub API endpoint');
    const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
      method,headers:{
        Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'nession-qwen-trusted-publisher',
        ...(method==='POST'?{'Content-Type':'application/json'}:{})},
      ...(method==='POST'?{body:JSON.stringify(payload)}:{}),
      signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Object.assign(
      Error('Publisher GitHub API rejected request'),{status:response.status});
    return response.json();
  };
}
export async function runTrustedQwenPublication({
  env,event,ingester,receipt,worker,artifacts,claimZip,resultZip,
  sourceCheckout,reader,registry,api,remote,
}){
  assertQwenPublisherRunAuthority(env,event,ingester,receipt);
  const signedArtifacts=authenticateWorkerClaimRun(worker,artifacts);
  const originalClaim=artifactFor(artifacts,worker,
    'development-worker-claim-'+worker.id+'-1',256*1024);
  if(signedArtifacts.artifact_id!==originalClaim.id||
      signedArtifacts.digest!==originalClaim.digest)
    fail('untrusted original Worker claim artifact');
  const originalResult=artifactFor(artifacts,worker,
    'development-worker-'+worker.id+'-1',32*1024*1024);
  const claim=inspectWorkerClaimZip(claimZip,originalClaim.digest,worker);
  if(sha256(resultZip)!==originalResult.digest.slice(7)||
      resultZip.length!==originalResult.size_in_bytes)
    fail('untrusted original Qwen Result ZIP');
  const result=zipJson(resultZip,'result.json');
  const proof=zipJson(resultZip,'proof.json');
  const ciphertext=zipJson(resultZip,'ciphertext.json');
  if(worker.id!==receipt.run_id||
      worker.run_attempt!==receipt.attempt||
      worker.head_sha!==receipt.worker_sha||
      claim.inputs.action_id!==receipt.action_id||
      Number(claim.inputs.issue_number)!==receipt.issue||
      claim.inputs.agent_id!=='dev-qwen-01')
    fail('ingester receipt does not match original signed Qwen Worker');
  const key=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    const preflight=await preflightTrustedQwenPublisher({
      remote,registry,run:worker,claim,reader,rootKey:key,
      result,proof,ciphertext,sourceCheckout});
    if(preflight.evidence.checkpoint_version!==receipt.checkpoint_version||
        preflight.evidence.checkpoint_commit_sha!==receipt.checkpoint_commit_sha||
        preflight.evidence.ciphertext_sha256!==receipt.ciphertext_sha256)
      fail('main-owned Ingest and Publisher native checkpoint disagree');
    const intent=commitQwenPublisherIntent({
      remote,preflight,target_main_sha:env.GITHUB_SHA,
      publisher_run_id:Number(env.GITHUB_RUN_ID)});
    const published=intent.may_publish
      ?await publishTrustedQwenGitHubPR({preflight,intent,sourceCheckout,api})
      :null;
    const readback=await readBackQwenPublishedPR({
      preflight,intent,sourceCheckout,api});
    if(published&&(published.head_sha!==readback.head_sha||
      published.pull_request!==readback.pull_request))
      fail('fresh Publisher response differs from independent PR readback');
    const handoff=applyQwenPublicationToRemote({
      remote,readback,intent,registry});
    return {schema_version:1,kind:'trusted_qwen_publisher_handoff',
      issue:receipt.issue,action_id:receipt.action_id,
      developer_run_id:worker.id,publisher_run_id:Number(env.GITHUB_RUN_ID),
      pull_request:readback.pull_request,pr_head_sha:readback.head_sha,
      reviewer_action_id:handoff.reviewer_action_id??null,
      status:handoff.changed?'reviewer_pending':'replayed',
      store_commit_sha:handoff.commit_sha??null};
  }finally{key.fill(0);}
}
async function main(){
  if(process.argv.length!==10||process.argv[2]!=='publish')
    fail('usage: publish INGEST_RUN_JSON RECEIPT_JSON WORKER_JSON ARTIFACTS_JSON CLAIM_ZIP RESULT_ZIP SOURCE_DIR');
  const env=process.env;
  if(!env.AGENT_STORE_CONTROLLER_REMOTE?.startsWith('https://x-access-token:')||
      !env.STORE_WRITER_PRIVATE_KEY||
      !env.PUBLISHER_GITHUB_TOKEN||
      env.PUBLISHER_GITHUB_TOKEN===env.STORE_APP_TOKEN||
      !env.ACTIONS_READ_TOKEN)
    fail('Publisher must have separately scoped Store/PR/Read authority');
  const source=process.argv[3],receiptFile=process.argv[4];
  const ingester=jsonFile(source,32*1024),
    receipt=jsonFile(receiptFile,8192);
  const event=jsonFile(env.GITHUB_EVENT_PATH,64*1024);
  assertQwenPublisherRunAuthority(env,event,ingester,receipt);
  const reader=createGitHubRunReader(env.ACTIONS_READ_TOKEN);
  const worker=await reader.getRun(receipt.run_id);
  const artifacts=jsonFile(process.argv[6],128*1024);
  const originalClaim=artifactFor(artifacts,worker,
    'development-worker-claim-'+worker.id+'-1',256*1024);
  const originalResult=artifactFor(artifacts,worker,
    'development-worker-'+worker.id+'-1',32*1024*1024);
  const claimZip=zipVerified(process.argv[7],originalClaim,256*1024);
  const resultZip=zipVerified(process.argv[8],originalResult,32*1024*1024);
  const result=await runTrustedQwenPublication({
    env,event,ingester,receipt,worker,artifacts,claimZip,resultZip,
    sourceCheckout:process.argv[9],reader,
    registry:jsonFile('automation/agents/registry.json',32*1024),
    api:apiClient(env.PUBLISHER_GITHUB_TOKEN),
    remote:env.AGENT_STORE_CONTROLLER_REMOTE,
  });
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
