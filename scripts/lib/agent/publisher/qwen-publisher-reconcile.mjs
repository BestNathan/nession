#!/usr/bin/env node
// #3885: one original, already-published Qwen PR -> Store Reviewer handoff.
// No model, no GitHub POST/PATCH and no new Store Publisher Intent grant.
// This process runs only from exact human owner/main issue_comment recovery.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {assertQwenPublisherRunAuthority,artifactFor,zipVerified,zipJson}
  from './qwen-trusted-publisher.mjs';
import {authenticateWorkerClaimRun,inspectWorkerClaimZip}
  from '../orchestration/worker-reconcile.mjs';
import {readWorkerZipMember} from '../orchestration/worker-zip.mjs';
import {deriveDispatchKey}
  from '../orchestration/controller-dispatch.mjs';
import {createGitHubRunReader}
  from '../orchestration/github-dispatch.mjs';
import {preflightTrustedQwenPublisher}
  from './qwen-source-preflight.mjs';
import {readCommittedQwenPublisherIntent,planQwenPublisherIntent}
  from './store-intent.mjs';
import {readBackQwenPublishedPR}
  from './qwen-github-publish.mjs';
import {composeQwenDeveloperResult}
  from '../orchestration/result-artifact.mjs';
import {applyQwenPublicationToRemote}
  from './publication-ingest.mjs';

const REPO='BestNathan/nession';
export const ORIGINAL=Object.freeze({
  issue:3784,worker_run_id:44259490499,ingester_run_id:44281068067,
  publisher_run_id:44281178406,pr:3919,
  action_id:'39c01222a8d00fa30bf681908ff6065f66cb74c96dc7314b16fbe6de0219f8bc',
  source_sha:'76ed2d01195ad31ecdef97bc40ffa9f6d48427e6',
  target_sha:'ec2984381bda57491d764a9ba3e1123a63b89861',
  pr_sha:'5d7e9118b7e954e760cc680fff7d43b4f9e17612',
  checkpoint_sha:'0eb0963d7365679d0f0448fbcd54ad270bc90ce2',
  patch_sha256:'216249d2ecad6657921a00fb2ce475dd4540defc624984a6c65f1bb5d04d2121',
  worker_sha:'d112a26c69a3e7e694b32152d61883c957c3f17b',
  ciphertext_sha256:'2c7faf10c4648ad21698cb4e4d34caa9acda11c7e62e504a51768891abc1b052',
});
export const COMMAND='/nession reconcile-qwen-pr issue=3784 publisher_run=44281178406 pr=3919';
const SHA=/^[0-9a-f]{40}$/;
function fail(message){throw Error('Qwen original Publisher GET-only recovery: '+message);}
function positive(value){return Number.isSafeInteger(value)&&value>0;}
export function assertOwnerQwenPublisherRecovery({env,event,run,jobs,receipt,ingester}){
  const s=ORIGINAL;
  if(env?.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==REPO||
      env.GITHUB_WORKFLOW!=='Store / Qwen Publisher'||
      env.GITHUB_EVENT_NAME!=='issue_comment'||
      env.GITHUB_REF!=='refs/heads/main'||
      env.GITHUB_ACTOR!=='BestNathan'||
      env.GITHUB_RUN_ATTEMPT!=='1'||!positive(Number(env.GITHUB_RUN_ID))||
      !SHA.test(env.GITHUB_SHA??'')||
      event?.action!=='created'||event.repository?.full_name!==REPO||
      event.issue?.number!==s.issue||event.issue?.state!=='open'||
      event.issue?.pull_request||event.comment?.user?.login!=='BestNathan'||
      !positive(event.comment?.id)||event.comment.body!==COMMAND)
    fail('not the exact trusted Owner/main recovery command');
  if(run?.id!==s.publisher_run_id||run.run_attempt!==1||
      run.status!=='completed'||run.conclusion!=='failure'||
      run.event!=='workflow_run'||run.name!=='Store / Qwen Publisher'||
      run.path!=='.github/workflows/store-qwen-publisher.yml'||
      run.head_branch!=='main'||run.head_sha!==s.target_sha||
      run.actor?.login!=='BestNathan'||run.repository?.full_name!==REPO||
      run.head_repository?.full_name!==REPO||
      !Number.isFinite(Date.parse(run.created_at??'')))
    fail('not the original failed main-owned Publisher Run');
  const names=['detect','publish','wake-reviewer'];
  if(jobs?.total_count!==names.length||jobs.jobs?.length!==names.length||
      names.some(n=>jobs.jobs.filter(j=>j.name===n).length!==1))
    fail('incomplete or unexpected original Publisher Jobs');
  const detect=jobs.jobs.find(j=>j.name==='detect');
  const published=jobs.jobs.find(j=>j.name==='publish');
  const wake=jobs.jobs.find(j=>j.name==='wake-reviewer');
  const steps=published.steps??[];
  const exact=(name,outcome)=>steps.filter(x=>x.name===name&&
    x.conclusion===outcome).length===1;
  if(detect.conclusion!=='success'||published.conclusion!=='failure'||
      wake.conclusion!=='skipped'||
      !exact('Authenticate original Qwen and publish/reconcile one real PR','failure')||
      !exact('Publish bounded Developer v2 producer and Store writer receipt','skipped'))
    fail('the failed original Publisher did not reach the exact partial publish boundary');
  if(ingester?.id!==s.ingester_run_id||
      ingester?.status!=='completed'||ingester.conclusion!=='success'||
      ingester.event!=='issue_comment'||
      ingester.name!=='Store / Agent Development Ingest'||
      ingester.path!=='.github/workflows/store-agent-development-ingest.yml'||
      ingester.head_sha!==s.target_sha||
      ingester.actor?.login!=='BestNathan'||
      ingester.repository?.full_name!==REPO)
    fail('original successful main Ingest Run changed identity');
  if(receipt?.status!=='committed'||
      receipt?.ingester_run_id!==s.ingester_run_id||
      receipt?.run_id!==s.worker_run_id||
      receipt?.action_id!==s.action_id||
      receipt?.issue!==s.issue||
      receipt?.worker_sha!==s.worker_sha||
      receipt?.ciphertext_sha256!==s.ciphertext_sha256||
      receipt?.checkpoint_commit_sha!==s.checkpoint_sha)
    fail('Ingest receipt diverged from original signed Worker/Store');
  // Reuse the canonical Qwen Publisher authorization checks against the
  // independently fetched original Run and original completed Ingest.
  assertQwenPublisherRunAuthority({
    ...env,GITHUB_EVENT_NAME:'workflow_run',
    GITHUB_SHA:run.head_sha,GITHUB_RUN_ID:String(run.id),
  },{action:'completed',workflow_run:{
    id:ingester.id,head_sha:ingester.head_sha,conclusion:'success',
  }},ingester,receipt);
  return Object.freeze({issue:s.issue,run_id:s.publisher_run_id,pr:s.pr});
}
export function getOnlyQwenPrApi(token){
  if(typeof token!=='string'||token.length<8||/\s/.test(token))
    fail('missing read-only GitHub token');
  const s=ORIGINAL,branch='agent/'+s.issue+'/qwen-'+s.action_id.slice(0,16);
  const paths=new Set([
    'pulls?state=all&head=BestNathan:'+encodeURIComponent(branch)+'&per_page=100',
    'pulls/'+s.pr,
    'pulls/'+s.pr+'/files?per_page=100',
    'git/ref/heads/'+branch,
    'git/commits/'+s.pr_sha,
  ]);
  return async(method,endpoint,payload)=>{
    if(method!=='GET'||!paths.has(endpoint)||payload!==undefined)
      fail('GitHub write or unrelated PR read forbidden in recovery');
    const response=await fetch('https://api.github.com/repos/'+REPO+'/'+endpoint,{
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28'},
      signal:AbortSignal.timeout(20000),
    });
    if(!response.ok)throw Object.assign(Error('bound GitHub read failed'),
      {status:response.status});
    return response.json();
  };
}
export async function recoverOriginalQwenPublisher({
  env,event,originalRun,originalJobs,ingester,receipt,worker,artifacts,
  claimZip,resultZip,sourceCheckout,reader,registry,api,remote,
  readIntent=readCommittedQwenPublisherIntent,
  storeHandoff=applyQwenPublicationToRemote,
}){
  const s=ORIGINAL;
  assertOwnerQwenPublisherRecovery({
    env,event,run:originalRun,jobs:originalJobs,receipt,ingester});
  if(worker?.id!==s.worker_run_id||worker.run_attempt!==1||
      worker.status!=='completed'||worker.conclusion!=='success'||
      worker.head_branch!=='main'||worker.actor?.login!=='github-actions[bot]')
    fail('original successful Worker identity changed');
  const claimArt=artifactFor(artifacts,worker,
    'development-worker-claim-'+worker.id+'-1',256*1024);
  const resultArt=artifactFor(artifacts,worker,
    'development-worker-'+worker.id+'-1',32*1024*1024);
  const original=authenticateWorkerClaimRun(worker,artifacts);
  if(original.artifact_id!==claimArt.id||original.digest!==claimArt.digest||
      !Buffer.isBuffer(claimZip)||claimZip.length!==claimArt.size_in_bytes||
      createHash('sha256').update(claimZip).digest('hex')!==claimArt.digest.slice(7)||
      !Buffer.isBuffer(resultZip)||resultZip.length!==resultArt.size_in_bytes||
      createHash('sha256').update(resultZip).digest('hex')!==resultArt.digest.slice(7))
    fail('original GitHub ZIPs differ from verified Artifact SHA256');
  const claim=inspectWorkerClaimZip(claimZip,claimArt.digest,worker);
  if(claim.inputs.task!=='implement'||claim.inputs.agent_id!=='dev-qwen-01'||
      claim.inputs.input_sha!==s.source_sha||
      claim.inputs.action_id!==s.action_id||
      Number(claim.inputs.issue_number)!==s.issue||
      receipt.worker_sha!==worker.head_sha)
    fail('original signed Worker claim does not match Source/Store');
  if(typeof sourceCheckout!=='string'||!path.isAbsolute(sourceCheckout)||
      typeof api!=='function')
    fail('missing inert original main checkout or PR GET reader');
  const intent=readIntent({remote,issue:s.issue,action_id:s.action_id,
    worker_run_id:s.worker_run_id,publisher_run_id:s.publisher_run_id});
  if(intent?.status!=='reconcile'||intent.may_publish!==false||
      !SHA.test(intent.store_commit_sha??'')||
      intent.record?.source_sha!==s.target_sha||
      intent.record?.target_main_sha!==s.target_sha||
      intent.record?.worker_source_sha!==s.source_sha||
      intent.record?.patch_sha256!==s.patch_sha256||
      intent.record?.checkpoint_commit_sha!==s.checkpoint_sha)
    fail('original immutable Publisher Intent not a readback-only grant');
  const rootKey=deriveDispatchKey(env.STORE_WRITER_PRIVATE_KEY);
  try{
    const originalResult=zipJson(resultZip,'result.json');
    const originalProof=zipJson(resultZip,'proof.json');
    const originalCiphertext=zipJson(resultZip,'ciphertext.json');
    const preflight=await preflightTrustedQwenPublisher({
      remote,registry,run:worker,claim,reader,rootKey,
      result:originalResult,proof:originalProof,ciphertext:originalCiphertext,
      sourceCheckout,targetMainSha:intent.record.target_main_sha,
    });
    const planned=planQwenPublisherIntent({
      preflight,target_main_sha:s.target_sha,publisher_run_id:s.publisher_run_id,
    });
    if(JSON.stringify(planned)!==JSON.stringify(intent.record))
      fail('new Publisher proof differs from the immutable original Intent');
    const readback=await readBackQwenPublishedPR({
      preflight,intent,sourceCheckout,api});
    if(readback.pull_request!==s.pr||readback.head_sha!==s.pr_sha)
      fail('existing PR is not the exact original source-attested publication');
    const result=composeQwenDeveloperResult({
      receipt,worker,claim,originalResult:resultArt,
      resultJsonBytes:readWorkerZipMember(resultZip,'result.json'),
      readback,publisherRunId:s.publisher_run_id,
      signedSourceSha:intent.record.worker_source_sha,
    });
    const handoff=storeHandoff({
      remote,readback,intent,registry,developerResult:result});
    if(!handoff?.producer_result_path||
        !/^[a-f0-9]{64}$/.test(handoff.producer_result_sha256??''))
      fail('reconciled Qwen Store missing immutable Developer v2 result');
    return Object.freeze({schema_version:1,kind:'trusted_qwen_get_only_recovery',
      status:handoff.changed?'reviewer_pending':'replayed',
      issue:s.issue,developer_run_id:worker.id,
      original_publisher_run_id:s.publisher_run_id,pr:s.pr,
      pr_head_sha:readback.head_sha,
      reviewer_action_id:handoff.reviewer_action_id??null,
      store_commit_sha:handoff.commit_sha??null,
      producer_result_path:handoff.producer_result_path});
  }finally{rootKey.fill(0);}
}
function jsonFile(file,max=128*1024){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>max)
    fail('untrusted recovery input file');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
async function main(){
  if(process.argv.length!==12||process.argv[2]!=='recover')
    fail('usage: recover ORIGINAL_RUN ORIGINAL_JOBS INGEST_RUN RECEIPT WORKER ARTIFACTS CLAIM_ZIP RESULT_ZIP SOURCE_DIR');
  const env=process.env;
  const event=jsonFile(env.GITHUB_EVENT_PATH,32*1024);
  const [originalRun,originalJobs,ingester,receipt,worker,artifacts]=
    process.argv.slice(3,9).map(f=>jsonFile(f,192*1024));
  assertOwnerQwenPublisherRecovery({
    env,event,run:originalRun,jobs:originalJobs,ingester,receipt});
  if(!env.AGENT_STORE_CONTROLLER_REMOTE?.startsWith('https://x-access-token:')||
      !env.STORE_WRITER_PRIVATE_KEY||!env.ACTIONS_READ_TOKEN||
      !env.GITHUB_TOKEN||!env.STORE_APP_TOKEN)
    fail('trusted Store writer/read-only credential boundary missing');
  const [claimArt,resultArt]=[
    artifactFor(artifacts,worker,'development-worker-claim-'+ORIGINAL.worker_run_id+'-1',256*1024),
    artifactFor(artifacts,worker,'development-worker-'+ORIGINAL.worker_run_id+'-1',32*1024*1024)];
  const result=await recoverOriginalQwenPublisher({
    env,event,originalRun,originalJobs,ingester,receipt,worker,artifacts,
    claimZip:zipVerified(process.argv[9],claimArt,256*1024),
    resultZip:zipVerified(process.argv[10],resultArt,32*1024*1024),
    sourceCheckout:process.argv[11],
    reader:createGitHubRunReader(env.ACTIONS_READ_TOKEN),
    registry:jsonFile('automation/agents/registry.json',64*1024),
    api:getOnlyQwenPrApi(env.GITHUB_TOKEN),
    remote:env.AGENT_STORE_CONTROLLER_REMOTE,
  });
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))
  main().catch(e=>{console.error('::error::'+e.message);process.exitCode=1;});
